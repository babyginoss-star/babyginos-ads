import { createClient } from "@supabase/supabase-js";

export const handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const [{ data: ads, error: e1 }, { data: snaps, error: e2 }] = await Promise.all([
    supabase.from("ads").select("ad_id, ad_name, campaign_name, funnel, status, updated_at"),
    supabase.from("ad_snapshots").select("ad_id, spend, cpm, frequency, ctr, impressions, reach, results, cost_per_result")
  ]);

  if (e1) return { statusCode: 500, headers, body: JSON.stringify({ error: e1.message }) };
  if (e2) return { statusCode: 500, headers, body: JSON.stringify({ error: e2.message }) };

  // Agregar snapshots por ad_id
  const agg = {};
  for (const s of snaps) {
    if (!agg[s.ad_id]) agg[s.ad_id] = { spend: 0, impressions: 0, reach: 0, results: 0, cpm_sum: 0, freq_sum: 0, ctr_sum: 0, count: 0 };
    const a = agg[s.ad_id];
    a.spend += s.spend || 0;
    a.impressions += s.impressions || 0;
    a.reach += s.reach || 0;
    a.results += s.results || 0;
    a.cpm_sum += s.cpm || 0;
    a.freq_sum += s.frequency || 0;
    a.ctr_sum += s.ctr || 0;
    a.count++;
  }

  const result = ads.map(ad => {
    const a = agg[ad.ad_id] || {};
    const n = a.count || 1;
    const cpa = a.results > 0 ? a.spend / a.results : null;
    return {
      ad_id: ad.ad_id,
      name: ad.ad_name,
      campaign: ad.campaign_name,
      funnel: ad.funnel,
      status: ad.status,
      spend: a.spend || 0,
      impressions: a.impressions || 0,
      reach: a.reach || 0,
      results: a.results || 0,
      cpm: a.count ? a.cpm_sum / n : null,
      frequency: a.count ? a.freq_sum / n : null,
      ctr: a.count ? a.ctr_sum / n : null,
      cpa,
      updated_at: ad.updated_at
    };
  }).sort((a, b) => (b.spend || 0) - (a.spend || 0));

  return { statusCode: 200, headers, body: JSON.stringify({ ads: result }) };
};
