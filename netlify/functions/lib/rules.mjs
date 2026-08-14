// ============================================================
// MOTOR DE REGLAS · Método 4Pi — Baby Ginos Ads Reader
// ============================================================
// evaluateAd recibe la ventana exacta de snapshots a analizar.
// El caller (sync-ads) decide el período: últimos 7 días o días 8-14.
// Esto garantiza que lo que se clasifica es lo que se muestra en el panel.

export const CONFIG = {
  MIN_DAYS_TO_JUDGE: 3,       // snapshots mínimos en la ventana para evaluar
  CPM_THRESHOLD: 10000,       // umbral CPM ($ARS)
  FREQ_TOFU_MAX: 1.5,         // <= 1.5 = TOFU (freq baja)
  FREQ_BOFU_MIN: 2.5,         // >= 2.5 = BOFU (freq alta)
  CPA_VERDE:       45000,     // <= 45k → verde
  CPA_PROMETEDOR:  55000,     // 45k-55k → amarillo
  CPA_ATENCION:    70000,     // > 70k → rojo / Pausar
  MIN_RESULTS_TO_CLASSIFY: 1, // promedio >= 1 compra/día activo para clasificar con gasto bajo
};

export function cpaColor(cpa) {
  if (cpa == null) return 'gris';
  if (cpa <= CONFIG.CPA_VERDE)      return 'verde';
  if (cpa <= CONFIG.CPA_PROMETEDOR) return 'amarillo';
  if (cpa <= CONFIG.CPA_ATENCION)   return 'naranja';
  return 'rojo';
}

export function classifyFunnel(frecuencia) {
  if (frecuencia <= CONFIG.FREQ_TOFU_MAX) return 'TOFU';
  if (frecuencia >= CONFIG.FREQ_BOFU_MIN) return 'BOFU';
  return 'MOFU';
}

function avg(rows, field) {
  const vals = rows.map(r => Number(r[field])).filter(n => !isNaN(n) && n > 0);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Evalúa un anuncio dado una ventana exacta de snapshots.
 *
 * @param {object} ad        - metadata del anuncio (ad_id, campaign_name, …)
 * @param {Array}  snapshots - snapshots del período a evaluar (ya filtrados por el caller)
 * @param {object} ctx       - { campaignSpendAvg: { [campaign_name]: number } }
 * @returns {{ funnel, status, mensaje }}
 */
export function evaluateAd(ad, snapshots, ctx = {}) {
  if (!snapshots || snapshots.length < CONFIG.MIN_DAYS_TO_JUDGE) {
    return { funnel: 'TOFU', status: 'sin_evaluar', mensaje: 'Sin datos suficientes para evaluar.' };
  }

  const totalSpend = snapshots.reduce((a, r) => a + (Number(r.spend) || 0), 0);
  if (totalSpend <= 0) {
    return { funnel: 'TOFU', status: 'sin_evaluar', mensaje: 'Sin gasto en el período.' };
  }

  const avgFreq    = avg(snapshots, 'frequency') ?? 0;
  const avgCPM     = avg(snapshots, 'cpm');
  const avgCPR     = avg(snapshots, 'cost_per_result');
  const avgResults = avg(snapshots, 'results');

  const funnel   = classifyFunnel(avgFreq);
  const freqBaja = avgFreq <= CONFIG.FREQ_TOFU_MAX;
  const freqAlta = avgFreq >= CONFIG.FREQ_BOFU_MIN;
  const cpmBajo  = avgCPM != null && avgCPM <  CONFIG.CPM_THRESHOLD;
  const cpmAlto  = avgCPM != null && avgCPM >= CONFIG.CPM_THRESHOLD;

  // gastoAlto: gasta igual o más que el promedio de su campaña en el mismo período
  const campAvg   = ctx.campaignSpendAvg?.[ad.campaign_name];
  const gastoAlto = campAvg != null && campAvg > 0 && totalSpend >= campAvg;

  // tieneComprasSuficientes: >= 1 compra/día activo → las métricas son estadísticamente válidas
  const tieneComprasSuficientes = avgResults != null && avgResults >= CONFIG.MIN_RESULTS_TO_CLASSIFY;

  const clasificable = gastoAlto || tieneComprasSuficientes;
  const gastoBajo    = !gastoAlto;

  const costoBueno      = avgCPR != null && avgCPR <= CONFIG.CPA_VERDE;
  const costoPrometedor = avgCPR != null && avgCPR >  CONFIG.CPA_VERDE && avgCPR <= CONFIG.CPA_PROMETEDOR;
  const costoAtencion   = avgCPR != null && avgCPR >  CONFIG.CPA_PROMETEDOR;
  const cpaRojo         = avgCPR != null && avgCPR >  CONFIG.CPA_ATENCION;
  const sinDatos        = avgCPR == null;

  // 1. Tractor: clasificable + freq baja + CPM bajo + CPA <= 45k
  if (clasificable && freqBaja && cpmBajo && costoBueno)
    return { funnel, status: 'tractor',
      mensaje: 'El Tractor — Meta lo favorece, llega a gente nueva y convierte. Escalá.' };

  // 2. Prometedor: clasificable + freq baja + CPM bajo + CPA $45k-$55k
  if (clasificable && freqBaja && cpmBajo && costoPrometedor)
    return { funnel, status: 'prometedor',
      mensaje: 'Prometedor — casi un Tractor, CPA en amarillo. Optimizá y puede escalar.' };

  // 3a. Pausar: gasto alto + CPA > $70k
  if (gastoAlto && cpaRojo)
    return { funnel, status: 'pausar',
      mensaje: 'Pausar — CPA rojo con gasto alto. Pausalo ahora.' };

  // 3b. Atención: clasificable + CPA > $55k
  if (clasificable && costoAtencion)
    return { funnel, status: 'atencion',
      mensaje: 'Atención — CPA caro. Decidí si pausás o seguís mirando.' };

  // 4. Cerrador: clasificable + freq alta + CPA <= 45k
  if (clasificable && freqAlta && costoBueno)
    return { funnel, status: 'cerrador',
      mensaje: 'El Cerrador — cierra bien en audiencia caliente. No escala en frío.' };

  // 5. No suma: gasto bajo + freq baja + CPM alto + sin datos
  if (gastoBajo && freqBaja && cpmAlto && sinDatos)
    return { funnel, status: 'no_suma',
      mensaje: 'El que no suma — Meta no lo favorece, caro y sin conversiones.' };

  // 6. Sin evaluar
  return { funnel, status: 'sin_evaluar',
    mensaje: 'Sin evaluar — no encaja en ningún patrón definido aún.' };
}
