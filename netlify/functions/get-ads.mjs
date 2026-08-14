import { createClient } from "@supabase/supabase-js";

export const handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Ventana de 7 días — misma que usa el clasificador
  const d7ago = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];

  const [{ data: ads, error: e1 }, { data: snaps, error: e2 }] = await Promise.all([
    supabase.from("ads").select(
      "ad_id, ad_name, campaign_name, funnel, status, prev_status, prev_funnel, prev_evaluated_at, thumbnail_url, updated_at"
    ),
    // Solo últimos 7 días — los mismos datos que usa la clasificación
    supabase.from("ad_snapshots").select(
      "ad_id, day, spend, cpm, frequency, impressions, reach, results, cost_per_result"
    ).gte("day", d7ago),
  ]);

  if (e1 || e2) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: (e1 || e2).message }) };
  }

  // Agregar métricas de los últimos 7 días por anuncio
  const snapMap = {};
  for (const s of snaps || []) {
    if (!snapMap[s.ad_id]) {
      snapMap[s.ad_id] = { spend: 0, impressions: 0, reach: 0, results: 0, cpms: [], freqs: [], cprs: [] };
    }
    const m = snapMap[s.ad_id];
    m.spend       += Number(s.spend)       || 0;
    m.impressions += Number(s.impressions) || 0;
    m.reach       += Number(s.reach)       || 0;
    m.results     += Number(s.results)     || 0;
    if (s.cpm)             m.cpms.push(Number(s.cpm));
    if (s.frequency)       m.freqs.push(Number(s.frequency));
    if (s.cost_per_result) m.cprs.push(Number(s.cost_per_result));
  }

  const result = (ads || []).map((ad) => {
    const m       = snapMap[ad.ad_id] || { spend: 0, impressions: 0, reach: 0, results: 0, cpms: [], freqs: [], cprs: [] };
    const avgCPM  = m.cpms.length  ? m.cpms.reduce((a, b) => a + b, 0)  / m.cpms.length  : null;
    const avgFreq = m.freqs.length ? m.freqs.reduce((a, b) => a + b, 0) / m.freqs.length : null;
    const avgCPA  = m.cprs.length  ? m.cprs.reduce((a, b) => a + b, 0)  / m.cprs.length  : null;
    return {
      ad_id:             ad.ad_id,
      name:              ad.ad_name,
      campaign:          ad.campaign_name,
      funnel:            ad.funnel,
      status:            ad.status,
      prev_status:       ad.prev_status,
      prev_funnel:       ad.prev_funnel,
      prev_evaluated_at: ad.prev_evaluated_at,
      thumbnail_url:     ad.thumbnail_url,
      spend:             m.spend,
      impressions:       m.impressions,
      reach:             m.reach,
      results:           m.results,
      cpm:               avgCPM,
      frequency:         avgFreq,
      cpa:               avgCPA,
      updated_at:        ad.updated_at,
    };
  }).sort((a, b) => b.spend - a.spend);

  return { statusCode: 200, headers, body: JSON.stringify({ ads: result }) };
};
