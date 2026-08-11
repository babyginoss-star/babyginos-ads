// ============================================================
//  MOTOR DE REGLAS  ·  el "cerebro" de la app
// ============================================================
// Acá vive toda la lógica que Meta NO te da:
//  - clasificación de funnel (TOF / MOF / BOF)
//  - detección de fatiga comparando "corto" vs "baseline"
//
// Todos los umbrales están arriba para que los ajustes sin tocar el resto.

export const CONFIG = {
  BASELINE_DAYS: 7,          // días 1-7 del anuncio = baseline (se congela)
  SHORT_WINDOW_DAYS: 3,      // "ahora" = promedio de los últimos 3 días
  FREQ_WINDOW_DAYS: 7,       // frecuencia se mide sobre los últimos 7 días
  MIN_DAYS_TO_JUDGE: 5,      // antes de esto el anuncio está "en aprendizaje"

  // Umbrales de fatiga
  FREQ_CEILING: 3.0,         // frecuencia alta (frío). Retargeting tolera más.
  CTR_DROP_PCT: 0.20,        // CTR caído 20% vs su propia semana 1
  CPM_RISE_PCT: 0.15,        // CPM subiendo 15%+
  SIGNALS_TO_FLAG: 2,        // con 2 de 3 en rojo => FATIGANDO

  // Umbral de "ganador": costo por resultado por debajo de tu tope
  CPA_MAX: 9999,             // <-- PONÉ ACÁ tu CPA máximo real de Baby Ginos
};

/**
 * Clasifica el funnel del anuncio.
 * Prioridad: 1) convención de nombres  2) objetivo de campaña.
 */
export function classifyFunnel({ ad_name = "", campaign_name = "", objective = "" }) {
  const txt = `${campaign_name} ${ad_name}`.toUpperCase();

  // Lógica de Baby Ginos: el fondo de embudo (BOF) es lo ÚNICO que se etiqueta
  // explícitamente (conversión / retargeting). Todo lo demás es prospecting (TOF),
  // aunque sea una campaña de producto sin la etiqueta [PROSPECCION].
  // El nombre manda: en prospecting el objetivo también es OUTCOME_SALES.
  if (/CONVERSION|CONVERSIÓN|RETARGET|REMARKETING|RTG|\bBOF\b/.test(txt)) return "BOF";
  if (/CONSIDERAC|MIDDLE|\bMOF\b/.test(txt)) return "MOF";

  // Todo lo que no sea explícitamente BOF/MOF => prospecting
  return "TOF";
}

// Promedio simple de un campo sobre un set de snapshots
function avg(rows, field) {
  const vals = rows.map((r) => Number(r[field])).filter((n) => !isNaN(n));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Evalúa un anuncio a partir de TODOS sus snapshots (ordenados por día asc).
 * Devuelve { funnel, status, baseline, actual, señales, mensaje }.
 */
export function evaluateAd(ad, snapshots) {
  const snaps = [...snapshots].sort((a, b) => (a.day < b.day ? -1 : 1));
  const totalDays = snaps.length;

  const funnel = ad.funnel || classifyFunnel(ad);

  // Todavía no hay data suficiente para juzgar
  if (totalDays < CONFIG.MIN_DAYS_TO_JUDGE) {
    return { funnel, status: "nuevo", mensaje: "En aprendizaje — sin baseline aún." };
  }

  // Baseline = primeros N días (o los que haya). Se congela.
  const baseSnaps = snaps.slice(0, CONFIG.BASELINE_DAYS);
  const baseline = {
    ctr: ad.baseline_locked ? ad.baseline_ctr : avg(baseSnaps, "ctr"),
    cpm: ad.baseline_locked ? ad.baseline_cpm : avg(baseSnaps, "cpm"),
  };

  // Ventana corta = últimos N días
  const shortSnaps = snaps.slice(-CONFIG.SHORT_WINDOW_DAYS);
  const actual = {
    ctr: avg(shortSnaps, "ctr"),
    cpm: avg(shortSnaps, "cpm"),
    cost_per_result: avg(shortSnaps, "cost_per_result"),
  };

  // Frecuencia sobre los últimos 7 días (última lectura, es acumulativa)
  const freqSnaps = snaps.slice(-CONFIG.FREQ_WINDOW_DAYS);
  const frecuencia = Math.max(...freqSnaps.map((r) => Number(r.frequency) || 0));

  // --- Las 3 señales de fatiga ---
  const señales = [];
  if (frecuencia > CONFIG.FREQ_CEILING) señales.push("frecuencia alta");
  if (baseline.ctr && actual.ctr < baseline.ctr * (1 - CONFIG.CTR_DROP_PCT))
    señales.push("CTR cayó");
  if (baseline.cpm && actual.cpm > baseline.cpm * (1 + CONFIG.CPM_RISE_PCT))
    señales.push("CPM subió");

  // --- Decisión ---
  let status = "activo";
  let mensaje = "Sano.";

  if (señales.length >= CONFIG.SIGNALS_TO_FLAG) {
    status = "fatigando";
    mensaje = `Fatigando (${señales.join(" + ")}). Mantené el ángulo, reejecutá con hook/apertura nueva.`;
  } else if (
    actual.cost_per_result != null &&
    actual.cost_per_result <= CONFIG.CPA_MAX &&
    frecuencia <= CONFIG.FREQ_CEILING
  ) {
    status = "ganador";
    mensaje = "Ganador — protegé / escalá.";
  }

  return { funnel, status, baseline, actual, frecuencia, señales, mensaje };
}
