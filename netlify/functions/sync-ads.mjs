// ============================================================
// SYNC-ADS · función programada (corre 1 vez por día)
// ============================================================
// Flujo:
// 1. baja métricas diarias de Meta (últimos 14 días)
// 2. guarda/actualiza en Supabase (ads + ad_snapshots)
// 3. trae thumbnails de Meta y los guarda
// 4. corre el motor de reglas (Método 4Pi)
// 5. manda el resumen por Telegram
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

  // ---- 1. Bajar métricas diarias de Meta ----
  const rows = await fetchDailyInsights({
    accessToken: META_ACCESS_TOKEN,
    accountId: META_ACCOUNT_ID,
    days: 14,
  });

  // ---- 2. Guardar en Supabase ----
  const adsSeen = new Map();
  const snapshots = [];

  for (const r of rows) {
    const results = extractResults(r.actions, RESULT_ACTION_TYPE);
    const spend = Number(r.spend) || 0;

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

  // ---- 3. Traer thumbnails de Meta (en lotes de 50) ----
  const adIds = [...adsSeen.keys()];
  const thumbnailMap = {};
  const BATCH = 50;

  for (let i = 0; i < adIds.length; i += BATCH) {
    const batch = adIds.slice(i, i + BATCH);
    try {
      // Usar Meta Batch API (soportado en todas las versiones)
      // Paso 1: obtener creative IDs de cada ad
      const batchReq1 = batch.map(adId => ({
        method: "GET",
        relative_url: `${adId}?fields=creative`,
      }));
      const r1 = await fetch("https://graph.facebook.com/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          access_token: META_ACCESS_TOKEN,
          batch: JSON.stringify(batchReq1),
        }),
      });
      const d1 = await r1.json();

      // Mapeo adId → creativeId
      const adToCreative = {};
      const creativeIds = [];
      for (let j = 0; j < batch.length; j++) {
        const item = d1[j];
        if (item?.code === 200) {
          const body = JSON.parse(item.body);
          const cid = body?.creative?.id;
          if (cid) {
            adToCreative[batch[j]] = cid;
            creativeIds.push(cid);
          }
        }
      }

      if (!creativeIds.length) continue;

      // Paso 2: obtener thumbnails de los creatives directamente
      const batchReq2 = creativeIds.map(cid => ({
        method: "GET",
        relative_url: `${cid}?fields=thumbnail_url,image_url,object_story_spec`,
      }));
      const r2 = await fetch("https://graph.facebook.com/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          access_token: META_ACCESS_TOKEN,
          batch: JSON.stringify(batchReq2),
        }),
      });
      const d2 = await r2.json();

      // Mapeo creativeId → url
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

          // Paso 3: si sigue sin URL, intentar via video picture
          if (!url) {
            const videoId = cData?.object_story_spec?.video_data?.video_id;
            if (videoId) {
              try {
                const vRes = await fetch(
                  `https://graph.facebook.com/${videoId}?fields=picture&access_token=${META_ACCESS_TOKEN}`
                );
                const vData = await vRes.json();
                if (vData.picture) creativeToUrl[creativeIds[j]] = vData.picture;
              } catch (ve) {
                console.error(`Error fetching video picture ${videoId}:`, ve.message);
              }
            }
          }
        }
      }

      // Asignar thumbnail a cada adId
      for (const [adId, cid] of Object.entries(adToCreative)) {
        if (creativeToUrl[cid]) thumbnailMap[adId] = creativeToUrl[cid];
      }
    } catch (e) {
      console.error("Error fetching thumbnails batch:", e.message);
    }
  }

  // Guardar thumbnails en ads
  for (const [adId, url] of Object.entries(thumbnailMap)) {
    if (url) {
      await supabase.from("ads").update({ thumbnail_url: url }).eq("ad_id", adId);
    }
  }

  // ---- 4. Evaluar con Método 4Pi ----
  const { data: ads } = await supabase.from("ads").select("*");

  // Gasto total acumulado por anuncio
  const adTotalSpend = {};
  for (const s of snapshots) {
    adTotalSpend[s.ad_id] = (adTotalSpend[s.ad_id] || 0) + s.spend;
  }

  // Promedio de gasto por campaña
  const campaignSpendMap = {};
  for (const [adId, adMeta] of adsSeen) {
    const camp = adMeta.campaign_name;
    if (!campaignSpendMap[camp]) campaignSpendMap[camp] = [];
    campaignSpendMap[camp].push(adTotalSpend[adId] || 0);
  }
  const campaignSpendAvg = {};
  for (const [camp, spends] of Object.entries(campaignSpendMap)) {
    campaignSpendAvg[camp] = spends.reduce((a, b) => a + b, 0) / spends.length;
  }

  const ctx = { campaignSpendAvg };
  const evaluated = [];
  const today = new Date().toISOString().split("T")[0];

  for (const ad of ads || []) {
    const { data: snaps } = await supabase
      .from("ad_snapshots")
      .select("*")
      .eq("ad_id", ad.ad_id)
      .order("day", { ascending: true });

    const result = evaluateAd(ad, snaps || [], ctx);

    const daysSincePrev = ad.prev_evaluated_at
      ? Math.floor((new Date(today) - new Date(ad.prev_evaluated_at)) / (1000 * 60 * 60 * 24))
      : 999;

    const patch = {
      status: result.status,
      funnel: result.funnel,
      updated_at: new Date().toISOString(),
    };

    if (daysSincePrev >= 7) {
      patch.prev_status = ad.status || null;
      patch.prev_funnel = ad.funnel || null;
      patch.prev_evaluated_at = today;
    }

    await supabase.from("ads").update(patch).eq("ad_id", ad.ad_id);
    evaluated.push({ ad_id: ad.ad_id, ad_name: ad.ad_name, ...result });
  }

  // ---- 5. Resumen por Telegram ----
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram({
      botToken: TELEGRAM_BOT_TOKEN,
      chatId: TELEGRAM_CHAT_ID,
      text: buildDigest(evaluated),
    });
  }

  return new Response(
    JSON.stringify({ ok: true, ads: evaluated.length, snapshots: snapshots.length }),
    { headers: { "Content-Type": "application/json" } }
  );
}
