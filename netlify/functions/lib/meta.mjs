// ============================================================
//  Cliente de la Meta Marketing API (solo lectura)
// ============================================================
// Baja, para cada anuncio de la cuenta, una fila POR DÍA con las métricas.
// Usa time_increment=1 => Meta devuelve el desglose diario en una sola llamada,
// lo que además reconstruye el baseline de anuncios que ya venían corriendo.

const API_VERSION = "v23.0"; // versión estable de la Marketing API

// Campos que pedimos a nivel anuncio
const FIELDS = [
  "ad_id",
  "ad_name",
  "campaign_name",
  "objective",
  "spend",
  "cpm",
  "frequency",
  "ctr",
  "impressions",
  "reach",
  "actions", // de acá sacamos los "resultados" (ej. compras)
].join(",");

/**
 * Trae las métricas diarias de los últimos `days` días para toda la cuenta.
 * @returns {Promise<Array>} filas crudas de Meta (una por anuncio y por día)
 */
export async function fetchDailyInsights({ accessToken, accountId, days = 14 }) {
  const base = `https://graph.facebook.com/${API_VERSION}/${accountId}/insights`;
  const params = new URLSearchParams({
    level: "ad",
    fields: FIELDS,
    time_increment: "1",          // <- una fila por día
    date_preset: `last_${days}d`, // ej. last_14d
    limit: "500",
    access_token: accessToken,
  });

  let url = `${base}?${params.toString()}`;
  const rows = [];

  // Paginación: Meta devuelve los datos en páginas
  while (url) {
    const res = await fetch(url);
    const json = await res.json();
    if (json.error) {
      throw new Error(`Meta API: ${json.error.message}`);
    }
    rows.push(...(json.data || []));
    url = json.paging?.next || null;
  }
  return rows;
}

/**
 * Saca el número de "resultados" del array `actions` de Meta.
 * Por defecto busca compras; ajustá RESULT_ACTION_TYPE si tu objetivo es otro.
 */
export function extractResults(actions, resultActionType) {
  if (!Array.isArray(actions)) return 0;
  const hit = actions.find((a) => a.action_type === resultActionType);
  return hit ? Number(hit.value) : 0;
}
