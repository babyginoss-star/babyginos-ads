import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data, error } = await supabase
    .from("ads")
    .select("id, name, status, funnel, spend, impressions, reach, frequency, clicks, ctr, cpc, cpm, cpp, purchases, purchase_value, roas, cpa, created_at, updated_at")
    .order("spend", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ads: data });
}
