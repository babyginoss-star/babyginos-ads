// ============================================================
//  SYNC-ADS  ·  función programada (corre 1 vez por día)
// ============================================================
//  Flujo:
//   1. baja métricas diarias de Meta (últimos 14 días)
//   2. guarda/actualiza en Supabase (ads + ad_snapshots)
//   3. corre el motor de reglas (funnel + fatiga)
//   4. manda el resumen por Telegram
//
//  Todas las llaves viven en variables de entorno (Netlify), NUNCA en el código.

import { createClient } from "@supabase/supabase-js";
import { fetchDailyInsights, extractResults } from "./lib/meta.mjs";
import { evaluateAd, classifyFunnel, CONFIG } from "./lib/rules.mjs";
import { sendTelegram, buildDigest } from "./lib/telegram.mjs";

// Programación: todos los días a las 03:00 UTC = 00:00 (medianoche) en Argentina (UTC-3)
export const config = { schedule: "17 21 * * *" };

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
        // el funnel NO se decide acá: lo calcula el Método 4Pi en la evaluación,
        // a partir del comportamiento real (frecuencia/CPM/CPA) del anuncio.
        updated_at: new Date().toISOString(),
      });
    }
  }

  // upsert = inserta o actualiza sin duplicar
  if (adsSeen.size)
    await supabase.from("ads").upsert([...adsSeen.values()], { onConflict: "ad_id" });
  if (snapshots.length)
    await supabase.from("ad_snapshots").upsert(snapshots, { onConflict: "ad_id,day" });

  // ---- 3. Evaluar cada anuncio con el motor de reglas (Método 4Pi) ----
  const { data: ads } = await supabase.from("ads").select("*");
  const evaluated = [];

  // Contexto 4Pi: mediana de CPM de la cuenta (para saber qué es "alto/bajo")
  const cpms = snapshots.map((s) => Number(s.cpm)).filter((n) => n > 0).sort((a, b) => a - b);
  const cpmMedian = cpms.length ? cpms[Math.floor(cpms.length / 2)] : null;
  const ctx = { cpmMedian, cpaMax: Number(process.env.CPA_MAX) || CONFIG.CPA_MAX };

  for (const ad of ads || []) {
    const { data: snaps } = await supabase
      .from("ad_snapshots")
      .select("*")
      .eq("ad_id", ad.ad_id)
      .order("day", { ascending: true });

    const result = evaluateAd(ad, snaps || [], ctx);

    // Congelar baseline la primera vez que hay data suficiente
    const patch = { status: result.status, funnel: result.funnel, updated_at: new Date().toISOString() };
    if (!ad.baseline_locked && result.baseline?.ctr) {
      patch.baseline_ctr = result.baseline.ctr;
      patch.baseline_cpm = result.baseline.cpm;
      patch.baseline_locked = true;
    }
    await supabase.from("ads").update(patch).eq("ad_id", ad.ad_id);

    evaluated.push({ ad_code: ad.ad_code, ad_name: ad.ad_name, ...result });
  }

  // ---- 4. Mandar el resumen por Telegram ----
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
