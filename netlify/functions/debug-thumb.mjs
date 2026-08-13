import { createClient } from "@supabase/supabase-js";
export const handler = async () => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const { META_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: ads } = await supabase.from("ads").select("ad_id, ad_name").limit(3);
  if (!ads?.length) return { statusCode: 200, headers, body: JSON.stringify({ error: "no ads" }) };
  const adIds = ads.map(a => a.ad_id);
  const BASE = "https://graph.facebook.com/v21.0/";
  const summary = { adsCount: adIds.length, step1: null, step2: null };
  const r1 = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: META_ACCESS_TOKEN, batch: JSON.stringify(adIds.map(id => ({ method: "GET", relative_url: id + "?fields=creative" }))) }),
  });
  const d1 = await r1.json();
  const creativeIds = [];
  summary.step1 = d1.map((item, i) => {
    if (item?.code === 200) {
      const cid = JSON.parse(item.body)?.creative?.id;
      if (cid) creativeIds.push(cid);
      return { ad: adIds[i], code: 200, creativeId: cid || null };
    }
    return { ad: adIds[i], code: item?.code, error: item?.body?.slice?.(0, 120) };
  });
  if (!creativeIds.length) return { statusCode: 200, headers, body: JSON.stringify(summary, null, 2) };
  const r2 = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: META_ACCESS_TOKEN, batch: JSON.stringify(creativeIds.map(cid => ({ method: "GET", relative_url: cid + "?fields=thumbnail_url,image_url,object_story_spec" }))) }),
  });
  const d2 = await r2.json();
  summary.step2 = d2.map((item, i) => {
    if (item?.code === 200) {
      const c = JSON.parse(item.body);
      return { creativeId: creativeIds[i], code: 200, hasThumbnailUrl: !!c?.thumbnail_url, hasImageUrl: !!c?.image_url, hasVideoData: !!c?.object_story_spec?.video_data, videoId: c?.object_story_spec?.video_data?.video_id || null, fields: Object.keys(c) };
    }
    return { creativeId: creativeIds[i], code: item?.code, error: item?.body?.slice?.(0, 120) };
  });
  return { statusCode: 200, headers, body: JSON.stringify(summary, null, 2) };
};
