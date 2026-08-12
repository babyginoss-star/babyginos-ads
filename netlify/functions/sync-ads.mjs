// ============================================================
// SYNC-ADS · función programada (corre 1 vez por día)
// ============================================================
// Flujo:
// 1. baja métricas diarias de Meta (últimos 14 días)
// 2. guarda/actualiza en Supabase (ads + ad_snapshots)
// 3. corre el motor de reglas (Método 4Pi)
// 4. manda el resumen por Telegram
//
// Todas las llaves viven en variables de entorno (Netlify), NUNCA en el código.

import { createClient } from "@supabase/supabase-js";
import { fetchDailyInsights, extractResults } from "./lib/meta.mjs";
import { evaluateAd, CONFIG } from "./lib/rules.mjs";
import { sendTelegram, buildDigest } from "./lib/telegram.mjs";

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

  // ---- 3. Evaluar con Método 4Pi ----
  const { data: ads } = await supabase.from("ads").select("*");

  // Gasto total acumulado por anuncio
  const adTotalSpend = {};
  for (const s of snapshots) {
    adTotalSpend[s.ad_id] = (adTotalSpend[s.ad_id] || 0) + s.spend;
  }

  // Promedio de gasto por campaña (para detectar gastoAlto)
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

    // Cada 7 días, rotar el estado anterior
    if (daysSincePrev >= 7) {
      patch.prev_status = ad.status || null;
      patch.prev_funnel = ad.funnel || null;
      patch.prev_evaluated_at = today;
    }

    await supabase.from("ads").update(patch).eq("ad_id", ad.ad_id);
    evaluated.push({ ad_id: ad.ad_id, ad_name: ad.ad_name, ...result });
  }

  // ---- 4. Resumen por Telegram ----
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
