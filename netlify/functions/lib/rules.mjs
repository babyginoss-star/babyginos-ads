// ============================================================
// MOTOR DE REGLAS · Método 4Pi — Baby Ginos Ads Reader
// ============================================================
// Clasificación por comportamiento real del anuncio:
// El Tractor    → gasto alto + freq baja + CPM bajo + CPA bueno
// El Cerrador   → gasto alto + freq alta + CPM alto + CPA bueno
// El que no suma → gasto bajo + freq baja + CPM alto + sin datos
// Sin evaluar   → todo lo que no encaja en los 3 anteriores
//
// gastoAlto OR tieneComprasSuficientes (>= 2 compras en últimos 3 días)
// permite clasificar anuncios con gasto bajo pero conversiones reales

export const CONFIG = {
  BASELINE_DAYS: 7,
  SHORT_WINDOW_DAYS: 3,
  FREQ_WINDOW_DAYS: 7,
  MIN_DAYS_TO_JUDGE: 5,

  // CPM: umbral fijo de la cuenta Baby Ginos
  CPM_THRESHOLD: 10000,

  // Frecuencia (Método 4Pi)
  FREQ_TOFU_MAX: 1.5,  // <= 1.5 = TOFU (freq baja)
  FREQ_BOFU_MIN: 2.5,  // >= 2.5 = BOFU (freq alta)

  // CPA semáforo (pesos ARS)
  CPA_VERDE:       45000,  // <= 45k = verde (aceptable)
  CPA_PROMETEDOR:  55000,  // 45k-55k = prometedor (casi tractor)
  CPA_ATENCION:    70000,  // 56k-70k = atención (gastás plata, retorno malo)
                           // > 70k = rojo (no aceptable)

  // Mínimo de compras promedio en ventana corta para clasificar con gasto bajo
  MIN_RESULTS_TO_CLASSIFY: 2,
};

/** Semáforo de CPA */
export function cpaColor(cpa) {
  if (cpa == null) return "gris";
  if (cpa <= CONFIG.CPA_VERDE)      return "verde";
  if (cpa <= CONFIG.CPA_PROMETEDOR) return "amarillo";
  if (cpa <= CONFIG.CPA_ATENCION)   return "naranja";
  return "rojo";
}

/** Funnel por frecuencia */
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

/**
 * Evalúa un anuncio y devuelve { funnel, status, mensaje }.
 *
 * ctx debe incluir:
 *   campaignSpendAvg: { [campaign_name]: number } — promedio de gasto por campaña
 */
export function evaluateAd(ad, snapshots, ctx = {}) {
  const snaps = [...snapshots].sort((a, b) => (a.day < b.day ? -1 : 1));

  // Gasto total acumulado del anuncio
  const totalSpend = snaps.reduce((a, r) => a + (Number(r.spend) || 0), 0);

  // Frecuencia: promedio de los últimos 7 días
  const freqSnaps = snaps.slice(-CONFIG.FREQ_WINDOW_DAYS);
  const frecuencia = avg(freqSnaps, "frequency") ?? 0;

  // Funnel
  const funnel = classifyFunnel(frecuencia);

  // Sin datos suficientes → sin evaluar
  if (snaps.length < CONFIG.MIN_DAYS_TO_JUDGE || totalSpend <= 0) {
    return { funnel, status: "sin_evaluar", mensaje: "Sin datos suficientes para evaluar." };
  }

  // Ventana corta: últimos 3 días
  const shortSnaps = snaps.slice(-CONFIG.SHORT_WINDOW_DAYS);
  const avgCPM     = avg(shortSnaps, "cpm");
  const avgCPR     = avg(shortSnaps, "cost_per_result");
  const avgResults = avg(shortSnaps, "results");

  // ── Las 4 señales ──────────────────────────────────────────
  const campAvg   = ctx.campaignSpendAvg?.[ad.campaign_name];
  const gastoAlto = campAvg != null && campAvg > 0 && totalSpend >= campAvg;

  // tieneComprasSuficientes: >= 2 compras promedio en últimos 3 días
  // permite clasificar aunque el gasto sea bajo (las métricas son reales)
  const tieneComprasSuficientes = avgResults != null && avgResults >= CONFIG.MIN_RESULTS_TO_CLASSIFY;

  // clasificable = Meta lo favorece O tiene compras reales suficientes
  const clasificable = gastoAlto || tieneComprasSuficientes;
  const gastoBajo    = !gastoAlto;

  const freqBaja = frecuencia <= CONFIG.FREQ_TOFU_MAX;
  const freqAlta = frecuencia >= CONFIG.FREQ_BOFU_MIN;

  const cpmBajo = avgCPM != null && avgCPM <  CONFIG.CPM_THRESHOLD;
  const cpmAlto = avgCPM != null && avgCPM >= CONFIG.CPM_THRESHOLD;

  const costoBueno = avgCPR != null && avgCPR <= CONFIG.CPA_VERDE;
  const sinDatos   = avgCPR == null;
  // ───────────────────────────────────────────────────────────

  const costoPrometedor = avgCPR != null && avgCPR > CONFIG.CPA_VERDE && avgCPR <= CONFIG.CPA_PROMETEDOR;
  const costoAtencion   = avgCPR != null && avgCPR > CONFIG.CPA_PROMETEDOR && avgCPR <= CONFIG.CPA_ATENCION;

  // 1. El Tractor: clasificable + freq baja + CPM bajo + CPA <= 45k
  if (clasificable && freqBaja && cpmBajo && costoBueno) {
    return { funnel, status: "tractor",
      mensaje: "El Tractor — Meta lo favorece, llega a gente nueva y convierte. Escalá." };
  }

  // 2. Prometedor: clasificable + freq baja + CPM bajo + CPA $45k-$55k
  if (clasificable && freqBaja && cpmBajo && costoPrometedor) {
    return { funnel, status: "prometedor",
      mensaje: "Prometedor — casi un Tractor, CPA en amarillo. Optimizá y puede escalar." };
  }

  // 3. Atención: clasificable + CPA $56k-$70k
  if (clasificable && costoAtencion) {
    return { funnel, status: "atencion",
      mensaje: "Atención — CPA caro. Decidí si pausás o seguís mirando." };
  }

  // 4. El Cerrador: clasificable + freq alta + CPM alto + CPA <= 45k
  if (clasificable && freqAlta && cpmAlto && costoBueno) {
    return { funnel, status: "cerrador",
      mensaje: "El Cerrador — cierra bien en audiencia caliente. No escala en frío." };
  }

  // 5. El que no suma: gasto bajo + freq baja + CPM alto + sin datos
  if (gastoBajo && freqBaja && cpmAlto && sinDatos) {
    return { funnel, status: "no_suma",
      mensaje: "El que no suma — Meta no lo favorece, caro y sin conversiones. Revisar o pausar." };
  }

  // 6. Sin evaluar: todo lo demás
  return { funnel, status: "sin_evaluar",
    mensaje: "Sin evaluar — no encaja en ningún patrón definido aún." };
}
