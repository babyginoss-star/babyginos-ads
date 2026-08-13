// ============================================================
// SYNC-ADS · función programada (corre 1 vez por día)
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { fetchDailyInsights, extractResults } from "./lib/meta.mjs";
import { evaluateAd, CONFIG } from "./lib/rules.mjs";
import { sendTelegram, buildDigest } from "./lib/telegram.mjs";

export const config = { schedule: "5 2 * * *" };
export default async function handler() {
  const {
    META_ACCESS_TOKEN, META_ACCOUNT_ID,
    RESULT_ACTION_TYPE = "purchase",
    SUPABASE_URL, SUPABASE_SERVICE_KEY,
    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  } = process.env;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const rows = await fetchDailyInsights({ accessToken: META_ACCESS_TOKEN, accountId: META_ACCOUNT_ID, days: 14 });

  const adsSeen = new Map();
  const snapshots = [];

  for (const r of rows) {
    const results = extractResults(r.actions, RESULT_ACTION_TYPE);
    const spend = Number(r.spend) || 0;
    snapshots.push({
      ad_id: r.ad_id, day: r.date_start, spend,
      cpm: Number(r.cpm) || null, frequency: Number(r.frequency) || null,
      ctr: Number(r.ctr) || null, impressions: Number(r.impressions) || 0,
      reach: Number(r.reach) || 0, results,
      cost_per_result: results > 0 ? spend / results : null,
    });
    if (!adsSeen.has(r.ad_id)) {
      adsSeen.set(r.ad_id, { ad_id: r.ad_id, ad_name: r.ad_name, campaign_name: r.campaign_name, objective: r.objective, updated_at: new Date().toISOString() });
    }
  }

  if (adsSeen.size) await supabase.from("ads").upsert([...adsSeen.values()], { onConflict: "ad_id" });
  if (snapshots.length) await supabase.from("ad_snapshots").upsert(snapshots, { onConflict: "ad_id,day" });

  // ---- Thumbnails via Meta Batch API v21.0 ----
  const adIds = [...adsSeen.keys()];
  const thumbnailMap = {};
  const BATCH = 50;
  const META_BASE = "https://graph.facebook.com/v21.0/";

  for (let i = 0; i < adIds.length; i += BATCH) {
    const batch = adIds.slice(i, i + BATCH);
    try {
      // Paso 1: creative IDs
      const r1 = await fetch(META_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          access_token: META_ACCESS_TOKEN,
          batch: JSON.stringify(batch.map(id => ({ method: "GET", relative_url: `${id}?fields=creative` }))),
        }),
      });
      const d1 = await r1.json();

      const adToCreative = {};
      const creativeIds = [];
      for (let j = 0; j < batch.length; j++) {
        if (d1[j]?.code === 200) {
          const cid = JSON.parse(d1[j].body)?.creative?.id;
          if (cid) { adToCreative[batch[j]] = cid; creativeIds.push(cid); }
        }
      }
      if (!creativeIds.length) continue;

      // Paso 2: thumbnails de los creatives
      const r2 = await fetch(META_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          access_token: META_ACCESS_TOKEN,
          batch: JSON.stringify(creativeIds.map(cid => ({ method: "GET", relative_url: `${cid}?fields=thumbnail_url,image_url,object_story_spec` }))),
        }),
      });
      const d2 = await r2.json();

      const creativeToUrl = {};
      for (let j = 0; j < creativeIds.length; j++) {
        if (d2[j]?.code === 200) {
          const c = JSON.parse(d2[j].body);
          let url = c?.thumbnail_url || c?.image_url || c?.object_story_spec?.video_data?.image_url || c?.object_story_spec?.link_data?.picture || null;
          if (!url) {
            const vid = c?.object_story_spec?.video_data?.video_id;
            if (vid) {
              try {
                const vRes = await fetch(`${META_BASE}${vid}?fields=picture&access_token=${META_ACCESS_TOKEN}`);
                const vData = await vRes.json();
                if (vData.picture) url = vData.picture;
              } catch (ve) { console.error("video picture error:", ve.message); }
            }
          }
          creativeToUrl[creativeIds[j]] = url;
        }
      }

      for (const [adId, cid] of Object.entries(adToCreative)) {
        if (creativeToUrl[cid]) thumbnailMap[adId] = creativeToUrl[cid];
      }
    } catch (e) {
      console.error("Error fetching thumbnails batch:", e.message);
    }
  }

  for (const [adId, url] of Object.entries(thumbnailMap)) {
    if (url) await supabase.from("ads").update({ thumbnail_url: url }).eq("ad_id", adId);
  }

  // ---- Evaluar con Método 4Pi ----
  const { data: ads } = await supabase.from("ads").select("*");

  const adTotalSpend = {};
  for (const s of snapshots) adTotalSpend[s.ad_id] = (adTotalSpend[s.ad_id] || 0) + s.spend;

  const campaignSpendMap = {};
  for (const [adId, adMeta] of adsSeen) {
    const camp = adMeta.campaign_name;
    if (!campaignSpendMap[camp]) campaignSpendMap[camp] = [];
    campaignSpendMap[camp].push(adTotalSpend[adId] || 0);
  }
  const campaignSpendAvg = {};
  for (const [camp, spends] of Object.entries(campaignSpendMap))
    campaignSpendAvg[camp] = spends.reduce((a, b) => a + b, 0) / spends.length;

  const ctx = { campaignSpendAvg };
  const evaluated = [];
  const today = new Date().toISOString().split("T")[0];

  for (const ad of ads || []) {
    const { data: snaps } = await supabase.from("ad_snapshots").select("*").eq("ad_id", ad.ad_id).order("day", { ascending: true });
    const result = evaluateAd(ad, snaps || [], ctx);
    const daysSincePrev = ad.prev_evaluated_at ? Math.floor((new Date(today) - new Date(ad.prev_evaluated_at)) / 86400000) : 999;
    const patch = { status: result.status, funnel: result.funnel, updated_at: new Date().toISOString() };
    if (daysSincePrev >= 7) { patch.prev_status = ad.status || null; patch.prev_funnel = ad.funnel || null; patch.prev_evaluated_at = today; }
    await supabase.from("ads").update(patch).eq("ad_id", ad.ad_id);
    evaluated.push({ ad_id: ad.ad_id, ad_name: ad.ad_name, ...result });
  }

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
    await sendTelegram({ botToken: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID, text: buildDigest(evaluated) });

  return new Response(JSON.stringify({ ok: true, ads: evaluated.length, snapshots: snapshots.length }), { headers: { "Content-Type": "application/json" } });
}
