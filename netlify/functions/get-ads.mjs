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

  // Fetch ads with prev fields + campaign
  const [{ data: ads, error: e1 }, { data: snaps, error: e2 }] = await Promise.all([
    supabase.from("ads").select(
      "ad_id, ad_name, campaign_name, funnel, status, prev_status, prev_funnel, prev_evaluated_at, updated_at"
    ),
    supabase.from("ad_snapshots").select(
      "ad_id, spend, cpm, frequency, impressions, reach, results, cost_per_result"
    ),
  ]);

  if (e1 || e2) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: (e1 || e2).message }),
    };
  }

  // Aggregate snapshots per ad
  const snapMap = {};
  for (const s of snaps || []) {
    if (!snapMap[s.ad_id]) {
      snapMap[s.ad_id] = { spend: 0, impressions: 0, reach: 0, results: 0, cpms: [], freqs: [] };
    }
    const m = snapMap[s.ad_id];
    m.spend += Number(s.spend) || 0;
    m.impressions += Number(s.impressions) || 0;
    m.reach += Number(s.reach) || 0;
    m.results += Number(s.results) || 0;
    if (s.cpm) m.cpms.push(Number(s.cpm));
    if (s.frequency) m.freqs.push(Number(s.frequency));
  }

  const result = (ads || []).map((ad) => {
    const m = snapMap[ad.ad_id] || { spend: 0, impressions: 0, reach: 0, results: 0, cpms: [], freqs: [] };
    const avgCPM = m.cpms.length ? m.cpms.reduce((a, b) => a + b, 0) / m.cpms.length : null;
    const maxFreq = m.freqs.length ? Math.max(...m.freqs) : null;
    const cpa = m.results > 0 ? m.spend / m.results : null;
    return {
      ad_id: ad.ad_id,
      name: ad.ad_name,
      campaign: ad.campaign_name,
      funnel: ad.funnel,
      status: ad.status,
      prev_status: ad.prev_status,
      prev_funnel: ad.prev_funnel,
      prev_evaluated_at: ad.prev_evaluated_at,
      spend: m.spend,
      impressions: m.impressions,
      reach: m.reach,
      results: m.results,
      cpm: avgCPM,
      frequency: maxFreq,
      cpa,
      updated_at: ad.updated_at,
    };
  }).sort((a, b) => b.spend - a.spend);

  return { statusCode: 200, headers, body: JSON.stringify({ ads: result }) };
};
