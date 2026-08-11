import { createClient } from "@supabase/supabase-js";

export const handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data, error } = await supabase.from("ad_snapshots").select("*").limit(1);

  if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };

  return { statusCode: 200, headers, body: JSON.stringify({ cols: data.length ? Object.keys(data[0]) : [] }) };
};
