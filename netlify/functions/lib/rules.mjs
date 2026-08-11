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

  // Semáforo de CPA de Baby Ginos (en pesos):
  //   verde  => escalable / rentable
  //   amarillo => aceptable, vigilar
  //   rojo   => no rentable
  CPA_VERDE: 45000,          // CPA <= 45k  => verde
  CPA_AMARILLO: 55000,       // 45k < CPA <= 55k => amarillo ; CPA > 55k => rojo
  CPA_MAX: 45000,            // tope para considerar un anuncio "escalable" en el 4Pi
};

/** Devuelve el color del CPA según el semáforo de Baby Ginos. */
export function cpaColor(cpa) {
  if (cpa == null) return "gris";
  if (cpa <= CONFIG.CPA_VERDE) return "verde";
  if (cpa <= CONFIG.CPA_AMARILLO) return "amarillo";
  return "rojo";
}

// Umbrales del Método 4Pi (Prof. Charley T) — clasificación por comportamiento real
export const P4 = {
  FREQ_TOFU_MAX: 1.5,   // frecuencia ≤ 1.5 => alcance a gente nueva (TOFU)
  FREQ_BOFU_MIN: 2.5,   // frecuencia ≥ 2.5 => mismas personas repetidas (BOFU)
  CPM_HIGH: null,       // se calcula dinámico (mediana de la cuenta) si queda null
};

/**
 * Clasifica el funnel del anuncio con el MÉTODO 4Pi.
 * NO usa el nombre de la campaña: lee cómo el algoritmo USA el anuncio,
 * a partir de sus métricas reales (frecuencia = señal principal; CPM y CPA confirman).
 *
 * @param metrics { frequency, cpm, cost_per_result, spend }
 * @param ctx     { cpmMedian }  mediana de CPM de la cuenta, para comparar alto/bajo
 */
export function classifyFunnel(metrics = {}, ctx = {}) {
  const freq = Number(metrics.frequency) || 0;
  const cpm = Number(metrics.cpm) || 0;
  const cpa = metrics.cost_per_result != null ? Number(metrics.cost_per_result) : null;
  const spend = Number(metrics.spend) || 0;
  const cpmMedian = ctx.cpmMedian || null;

  // Paso 1: sin gasto suficiente, no hay señal confiable
  if (spend <= 0) return "SIN_DATOS";

  // Paso 2: la frecuencia da la posición tentativa en el embudo
  let funnel;
  if (freq <= P4.FREQ_TOFU_MAX) funnel = "TOFU";
  else if (freq >= P4.FREQ_BOFU_MIN) funnel = "BOFU";
  else funnel = "MOFU";

  // Paso 3: el CPM confirma o contradice. Si tenemos mediana de la cuenta:
  //   CPM claramente por debajo de la mediana refuerza TOFU (audiencia fría/amplia)
  //   CPM claramente por encima refuerza BOFU (audiencia acotada/competida)
  if (cpmMedian && cpm > 0) {
    const alto = cpm > cpmMedian * 1.3;
    const bajo = cpm < cpmMedian * 0.7;
    if (funnel === "MOFU" && bajo) funnel = "TOFU";
    if (funnel === "MOFU" && alto) funnel = "BOFU";
  }

  return funnel;
}

/** Diagnóstico 4Pi legible: qué está pasando con el anuncio y qué hacer. */
export function diagnose4Pi(metrics = {}, ctx = {}) {
  const freq = Number(metrics.frequency) || 0;
  const cpa = metrics.cost_per_result != null ? Number(metrics.cost_per_result) : null;
  const funnel = classifyFunnel(metrics, ctx);
  const color = cpaColor(cpa);          // verde | amarillo | rojo | gris
  const cpaBueno = color === "verde";   // "escalable" solo si CPA en verde

  if (funnel === "SIN_DATOS")
    return { funnel, cpaColor: color, diag: "Sin gasto suficiente — datos no confiables." };

  if (freq <= P4.FREQ_TOFU_MAX) {
    if (color === "verde") return { funnel, cpaColor: color, diag: "TOFU escalable ✅ — convierte en frío, pisá el acelerador." };
    if (color === "amarillo") return { funnel, cpaColor: color, diag: "TOFU aceptable 🟡 — rinde en frío pero el CPA está al límite, vigilar." };
    return { funnel, cpaColor: color, diag: "TOFU 🔴 — la creatividad no conecta con frío, revisar." };
  }
  if (freq >= P4.FREQ_BOFU_MIN) {
    if (cpaBueno) return { funnel, cpaColor: color, diag: "BOFU — convierte bien pero NO escala en frío (audiencia caliente)." };
    return { funnel, cpaColor: color, diag: "BOFU agotado ⚠️ — audiencia saturada, rotar/reejecutar." };
  }
  return { funnel, cpaColor: color, diag: "MOFU — zona de consideración, seguir de cerca." };
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
export function evaluateAd(ad, snapshots, ctx = {}) {
  const snaps = [...snapshots].sort((a, b) => (a.day < b.day ? -1 : 1));
  const totalDays = snaps.length;

  // Métricas recientes para el 4Pi
  const recent4 = snaps.slice(-CONFIG.SHORT_WINDOW_DAYS);
  const freqReciente = Math.max(...snaps.slice(-CONFIG.FREQ_WINDOW_DAYS).map((r) => Number(r.frequency) || 0), 0);
  const metrics4pi = {
    frequency: freqReciente,
    cpm: avg(recent4, "cpm"),
    cost_per_result: avg(recent4, "cost_per_result"),
    spend: snaps.reduce((a, r) => a + (Number(r.spend) || 0), 0),
  };
  // Funnel por MÉTODO 4Pi (comportamiento real del anuncio, no la campaña)
  const { funnel, diag: diag4pi } = diagnose4Pi(metrics4pi, ctx);

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
