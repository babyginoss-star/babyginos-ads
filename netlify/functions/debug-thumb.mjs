// Función de debug temporal — ver qué devuelve Meta para thumbnails
// Llamar: /.netlify/functions/debug-thumb
import { createClient } from "@supabase/supabase-js";

export const handler = async () => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const { META_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Tomar los primeros 3 ad_ids de la DB
  const { data: ads } = await supabase.from("ads").select("ad_id, ad_name").limit(3);
  if (!ads?.length) return { statusCode: 200, headers, body: JSON.stringify({ error: "no ads" }) };

  const ids = ads.map(a => a.ad_id).join(",");
  const result = { adIds: ids, steps: [] };

  // Paso 1: pedir creative IDs
  const r1 = await fetch(
    `https://graph.facebook.com/v19.0/?ids=${ids}&fields=creative&access_token=${META_ACCESS_TOKEN}`
  );
  const d1 = await r1.json();
  result.steps.push({ step: "1_creative_ids", response: d1 });

  // Paso 2: si hay creativeIds, pedir thumbnails
  const creativeIds = Object.values(d1)
    .map(ad => ad?.creative?.id)
    .filter(Boolean);

  if (creativeIds.length) {
    const cIds = creativeIds.join(",");
    const r2 = await fetch(
      `https://graph.facebook.com/v19.0/?ids=${cIds}&fields=thumbnail_url,image_url,object_story_spec&access_token=${META_ACCESS_TOKEN}`
    );
    const d2 = await r2.json();
    result.steps.push({ step: "2_creative_thumbnails", response: d2 });
  }

  return { statusCode: 200, headers, body: JSON.stringify(result, null, 2) };
};
