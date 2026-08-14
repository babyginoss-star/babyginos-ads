// ============================================================
// SYNC-ADS · función programada (corre 1 vez por día)
// ============================================================
// Flujo:
// 1. Baja métricas diarias de Meta (últimos 14 días)
// 2. Guarda/actualiza en Supabase (ads + ad_snapshots)
// 3. Trae thumbnails de Meta
// 4. Clasifica con Método 4Pi usando ventanas de 7 días:
//    - Estado actual  = últimos 7 días
//    - Estado anterior = días 8-14
// 5. Manda resumen por Telegram
//
// Todas las llaves viven en variables de entorno (Netlify), NUNCA en el código.

import { createClient } from "@supabase/supabase-js";
import { fetchDailyInsights, extractResults } from "./lib/meta.mjs";
import { evaluateAd, CONFIG } from "./lib/rules.mjs";
import { sendTelegram, buildDigest } from "./lib/telegram.mjs";

// Horario: 02:05 AM Argentina (05:05 UTC)
export const config = { schedule: "5 2 * * *" };

export default async function handler() {
  const {
    META_ACCESS_TOKEN,
    META_ACCOUNT_ID,
    RESULT_ACTION_TYPE = "purchase",
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
  } = process.env;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Fechas de las ventanas
  const today  = new Date().toISOString().split("T")[0];
  const d7ago  = new Date(Date.now() -  7 * 86400000).toISOString().split("T")[0];
  const d14ago = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];

  // ---- 1. Bajar métricas diarias de Meta (últimos 14 días) ----
  const rows = await fetchDailyInsights({
    accessToken: META_ACCESS_TOKEN,
    accountId: META_ACCOUNT_ID,
    days: 14,
  });

  // ---- 2. Guardar en Supabase ----
  const adsSeen   = new Map();
  const snapshots = [];

  for (const r of rows) {
    const results = extractResults(r.actions, RESULT_ACTION_TYPE);
    const spend   = Number(r.spend) || 0;

    snapshots.push({
      ad_id: r.ad_id,
      day: r.date_start,
      spend,
      cpm: Number(r.cpm) || null,
      frequency: Number(r.frequency) || null,
      ctr: Number(r.ctr) || null,
      impressions: Number(r.impressions) || 0,
      reach: Number(r.reach) || 0,
      results,
      cost_per_result: results > 0 ? spend / results : null,
    });

    if (!adsSeen.has(r.ad_id)) {
      adsSeen.set(r.ad_id, {
        ad_id: r.ad_id,
        ad_name: r.ad_name,
        campaign_name: r.campaign_name,
        objective: r.objective,
        updated_at: new Date().toISOString(),
      });
    }
  }

  if (adsSeen.size)
    await supabase.from("ads").upsert([...adsSeen.values()], { onConflict: "ad_id" });
  if (snapshots.length)
    await supabase.from("ad_snapshots").upsert(snapshots, { onConflict: "ad_id,day" });

  // ---- 3. Thumbnails de Meta (en lotes de 50) ----
  const adIds      = [...adsSeen.keys()];
  const thumbnailMap = {};
  const BATCH      = 50;

  for (let i = 0; i < adIds.length; i += BATCH) {
    const batch = adIds.slice(i, i + BATCH);
    try {
      const batchReq1 = batch.map(adId => ({
        method: "GET",
        relative_url: `${adId}?fields=creative`,
      }));
      const r1 = await fetch("https://graph.facebook.com/v21.0/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          access_token: META_ACCESS_TOKEN,
          batch: JSON.stringify(batchReq1),
        }),
      });
      const d1 = await r1.json();

      const adToCreative = {};
      const creativeIds  = [];
      for (let j = 0; j < batch.length; j++) {
        const item = d1[j];
        if (item?.code === 200) {
          const body = JSON.parse(item.body);
          const cid  = body?.creative?.id;
          if (cid) { adToCreative[batch[j]] = cid; creativeIds.push(cid); }
        }
      }
      if (!creativeIds.length) continue;

      const batchReq2 = creativeIds.map(cid => ({
        method: "GET",
        relative_url: `${cid}?fields=thumbnail_url,image_url,object_story_spec`,
      }));
      const r2 = await fetch("https://graph.facebook.com/v21.0/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          access_token: META_ACCESS_TOKEN,
          batch: JSON.stringify(batchReq2),
        }),
      });
      const d2 = await r2.json();

      const creativeToUrl = {};
      for (let j = 0; j < creativeIds.length; j++) {
        const item = d2[j];
        if (item?.code === 200) {
          const cData = JSON.parse(item.body);
          const url =
            cData?.thumbnail_url ||
            cData?.image_url ||
            cData?.object_story_spec?.video_data?.image_url ||
            cData?.object_story_spec?.link_data?.picture ||
            null;
          creativeToUrl[creativeIds[j]] = url;

          if (!url) {
            const videoId = cData?.object_story_spec?.video_data?.video_id;
            if (videoId) {
              try {
                const vRes  = await fetch(`https://graph.facebook.com/v21.0/${videoId}?fields=picture&access_token=${META_ACCESS_TOKEN}`);
                const vData = await vRes.json();
                if (vData.picture) creativeToUrl[creativeIds[j]] = vData.picture;
              } catch (ve) {
                console.error(`Error fetching video picture ${videoId}:`, ve.message);
              }
            }
          }
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

  // ---- 4. Clasificar con Método 4Pi ----

  // Gasto por período por anuncio
  const adSpend7d  = {};
  const adSpend14d = {};
  for (const s of snapshots) {
    if (s.day >= d7ago) {
      adSpend7d[s.ad_id]  = (adSpend7d[s.ad_id]  || 0) + s.spend;
    } else {
      adSpend14d[s.ad_id] = (adSpend14d[s.ad_id] || 0) + s.spend;
    }
  }

  // Promedio de gasto por campaña en cada período
  function buildCampaignAvg(spendMap) {
    const campMap = {};
    for (const [adId, adMeta] of adsSeen) {
      const camp = adMeta.campaign_name;
      if (!campMap[camp]) campMap[camp] = [];
      campMap[camp].push(spendMap[adId] || 0);
    }
    const avg = {};
    for (const [camp, arr] of Object.entries(campMap)) {
      avg[camp] = arr.reduce((a, b) => a + b, 0) / arr.length;
    }
    return avg;
  }

  const campaignAvgCurrent = buildCampaignAvg(adSpend7d);
  const campaignAvgPrev    = buildCampaignAvg(adSpend14d);

  const ctxCurrent = { campaignSpendAvg: campaignAvgCurrent };
  const ctxPrev    = { campaignSpendAvg: campaignAvgPrev };

  // Traer todos los snapshots de los últimos 14 días en una sola query
  const { data: recentSnaps } = await supabase
    .from("ad_snapshots")
    .select("*")
    .gte("day", d14ago)
    .order("day", { ascending: true });

  // Agrupar por ad_id y dividir en ventana actual (7d) y anterior (8-14d)
  const snapsByAd = {};
  for (const s of recentSnaps || []) {
    if (!snapsByAd[s.ad_id]) snapsByAd[s.ad_id] = { current: [], prev: [] };
    if (s.day >= d7ago) snapsByAd[s.ad_id].current.push(s);
    else                snapsByAd[s.ad_id].prev.push(s);
  }

  // Traer todos los ads
  const { data: ads } = await supabase.from("ads").select("*");

  const evaluated = [];

  for (const ad of ads || []) {
    const currentSnaps = snapsByAd[ad.ad_id]?.current || [];
    const prevSnaps    = snapsByAd[ad.ad_id]?.prev    || [];

    const currentResult = evaluateAd(ad, currentSnaps, ctxCurrent);
    const prevResult    = evaluateAd(ad, prevSnaps,    ctxPrev);

    await supabase.from("ads").update({
      status:      currentResult.status,
      funnel:      currentResult.funnel,
      prev_status: prevResult.status,
      prev_funnel: prevResult.funnel,
      updated_at:  new Date().toISOString(),
    }).eq("ad_id", ad.ad_id);

    evaluated.push({ ad_id: ad.ad_id, ad_name: ad.ad_name, ...currentResult });
  }

  // ---- 5. Resumen por Telegram ----
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram({
      botToken: TELEGRAM_BOT_TOKEN,
      chatId:   TELEGRAM_CHAT_ID,
      text:     buildDigest(evaluated),
    });
  }

  return new Response(
    JSON.stringify({ ok: true, ads: evaluated.length, snapshots: snapshots.length }),
    { headers: { "Content-Type": "application/json" } }
  );
}
