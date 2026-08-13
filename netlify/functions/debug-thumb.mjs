// Función de debug temporal — ver qué devuelve Meta para thumbnails
// Llamar: /.netlify/functions/debug-thumb
import { createClient } from "@supabase/supabase-js";

export const handler = async () => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const { META_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: ads } = await supabase.from("ads").select("ad_id, ad_name").limit(3);
  if (!ads?.length) return { statusCode: 200, headers, body: JSON.stringify({ error: "no ads" }) };

  const adIds = ads.map(a => a.ad_id);
  const result = { adIds, steps: [] };

  // Paso 1: batch para obtener creative IDs
  const batchReq1 = adIds.map(adId => ({ method: "GET", relative_url: `${adId}?fields=creative` }));
  const r1 = await fetch("https://graph.facebook.com/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: META_ACCESS_TOKEN, batch: JSON.stringify(batchReq1) }),
  });
  const d1 = await r1.json();
  result.steps.push({ step: "1_creative_ids", response: d1 });

  // Paso 2: obtener thumbnails de cada creative
  const creativeIds = d1
    .filter(item => item?.code === 200)
    .map(item => JSON.parse(item.body)?.creative?.id)
    .filter(Boolean);

  if (creativeIds.length) {
    const batchReq2 = creativeIds.map(cid => ({
      method: "GET",
      relative_url: `${cid}?fields=thumbnail_url,image_url,object_story_spec`,
    }));
    const r2 = await fetch("https://graph.facebook.com/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: META_ACCESS_TOKEN, batch: JSON.stringify(batchReq2) }),
    });
    const d2 = await r2.json();
    result.steps.push({ step: "2_creative_thumbnails", response: d2 });
  }

  return { statusCode: 200, headers, body: JSON.stringify(result, null, 2) };
};
