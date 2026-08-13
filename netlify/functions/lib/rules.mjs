// ============================================================
// MOTOR DE REGLAS - Metodo 4Pi - Baby Ginos Ads Reader
// ============================================================
// "clasificable" = gastoAlto (>= campAvg) OR tieneComprasSuficientes (>= 2 compras ultimos 3d)
//
// 1. Tractor    : clasificable + freq baja + CPM bajo + CPA <= 45k
// 2. Prometedor : clasificable + freq baja + CPM bajo + CPA 45k-55k
// 3. Atencion   : gastoAlto + CPA > 70k  (1 compra alcanza)
//                 clasificable + CPA > 55k (sin techo)
// 4. Cerrador   : clasificable + freq alta + CPM alto + CPA <= 45k
// 5. No suma    : gastoBajo + freq baja + CPM alto + sin datos
// 6. Sin evaluar: todo lo demas

export const CONFIG = {
  BASELINE_DAYS: 7,
  SHORT_WINDOW_DAYS: 3,
  FREQ_WINDOW_DAYS: 7,
  MIN_DAYS_TO_JUDGE: 5,

  CPM_THRESHOLD: 10000,

  FREQ_TOFU_MAX: 1.5,
  FREQ_BOFU_MIN: 2.5,

  CPA_VERDE:      45000,
  CPA_PROMETEDOR: 55000,
  CPA_ATENCION:   70000,

  MIN_RESULTS_TO_CLASSIFY: 2,
};

export function cpaColor(cpa) {
  if (cpa == null) return "gris";
  if (cpa <= CONFIG.CPA_VERDE)      return "verde";
  if (cpa <= CONFIG.CPA_PROMETEDOR) return "amarillo";
  if (cpa <= CONFIG.CPA_ATENCION)   return "naranja";
  return "rojo";
}

export function classifyFunnel(frecuencia) {
  if (frecuencia <= CONFIG.FREQ_TOFU_MAX) return "TOFU";
  if (frecuencia >= CONFIG.FREQ_BOFU_MIN) return "BOFU";
  return "MOFU";
}

function avg(rows, field) {
  const vals = rows.map(r => Number(r[field])).filter(n => !isNaN(n) && n > 0);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function evaluateAd(ad, snapshots, ctx = {}) {
  const snaps = [...snapshots].sort((a, b) => (a.day < b.day ? -1 : 1));

  const totalSpend = snaps.reduce((a, r) => a + (Number(r.spend) || 0), 0);

  const freqSnaps  = snaps.slice(-CONFIG.FREQ_WINDOW_DAYS);
  const frecuencia = avg(freqSnaps, "frequency") ?? 0;
  const funnel     = classifyFunnel(frecuencia);

  if (snaps.length < CONFIG.MIN_DAYS_TO_JUDGE || totalSpend <= 0) {
    return { funnel, status: "sin_evaluar", mensaje: "Sin datos suficientes para evaluar." };
  }

  const shortSnaps = snaps.slice(-CONFIG.SHORT_WINDOW_DAYS);
  const avgCPM     = avg(shortSnaps, "cpm");
  const avgCPR     = avg(shortSnaps, "cost_per_result");
  const avgResults = avg(shortSnaps, "results");

  const campAvg   = ctx.campaignSpendAvg?.[ad.campaign_name];
  const gastoAlto = campAvg != null && campAvg > 0 && totalSpend >= campAvg;
  const tieneComprasSuficientes = avgResults != null && avgResults >= CONFIG.MIN_RESULTS_TO_CLASSIFY;
  const clasificable = gastoAlto || tieneComprasSuficientes;
  const gastoBajo    = !gastoAlto;

  const freqBaja = frecuencia <= CONFIG.FREQ_TOFU_MAX;
  const freqAlta = frecuencia >= CONFIG.FREQ_BOFU_MIN;
  const cpmBajo  = avgCPM != null && avgCPM <  CONFIG.CPM_THRESHOLD;
  const cpmAlto  = avgCPM != null && avgCPM >= CONFIG.CPM_THRESHOLD;

  const costoBueno      = avgCPR != null && avgCPR <= CONFIG.CPA_VERDE;
  const costoPrometedor = avgCPR != null && avgCPR > CONFIG.CPA_VERDE && avgCPR <= CONFIG.CPA_PROMETEDOR;
  const costoAtencion   = avgCPR != null && avgCPR > CONFIG.CPA_PROMETEDOR;
  const cpaRojo         = avgCPR != null && avgCPR > CONFIG.CPA_ATENCION;
  const sinDatos        = avgCPR == null;

  // 1. Tractor
  if (clasificable && freqBaja && cpmBajo && costoBueno)
    return { funnel, status: "tractor", mensaje: "El Tractor - Meta lo favorece, llega a gente nueva y convierte. Escala." };

  // 2. Prometedor
  if (clasificable && freqBaja && cpmBajo && costoPrometedor)
    return { funnel, status: "prometedor", mensaje: "Prometedor - casi un Tractor, CPA en amarillo. Optimiza y puede escalar." };

  // 3a. Atencion rojo: gasto alto + CPA > 70k (aunque tenga 1 sola compra)
  if (gastoAlto && cpaRojo)
    return { funnel, status: "atencion", mensaje: "Atencion - CPA rojo con gasto alto. Pausar." };

  // 3b. Atencion: clasificable + CPA > 55k
  if (clasificable && costoAtencion)
    return { funnel, status: "atencion", mensaje: "Atencion - gastas plata pero el CPA esta caro. Decide si pausas o seguis mirando." };

  // 4. Cerrador
  if (clasificable && freqAlta && cpmAlto && costoBueno)
    return { funnel, status: "cerrador", mensaje: "El Cerrador - cierra bien en audiencia caliente. No escala en frio." };

  // 5. No suma
  if (gastoBajo && freqBaja && cpmAlto && sinDatos)
    return { funnel, status: "no_suma", mensaje: "El que no suma - Meta no lo favorece, caro y sin conversiones. Revisar o pausar." };

  // 6. Sin evaluar
  return { funnel, status: "sin_evaluar", mensaje: "Sin evaluar - no encaja en ningun patron definido aun." };
}
