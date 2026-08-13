// ============================================================
// MOTOR DE REGLAS · Método 4Pi — Baby Ginos Ads Reader
// ============================================================
// El Tractor     → gasto alto + freq baja + CPM bajo + CPA <= 45k
// Prometedor     → igual que Tractor pero CPA $45k-$55k
// Atención       → gasto alto + CPA $56k-$70k
// El Cerrador    → gasto alto + freq alta + CPM alto + CPA bueno
// El que no suma → gasto bajo + freq baja + CPM alto + sin datos
// Sin evaluar    → todo lo que no encaja

export const CONFIG = {
  BASELINE_DAYS: 7,
  SHORT_WINDOW_DAYS: 3,
  FREQ_WINDOW_DAYS: 7,
  MIN_DAYS_TO_JUDGE: 5,
  CPM_THRESHOLD: 10000,
  FREQ_TOFU_MAX: 1.5,
  FREQ_BOFU_MIN: 2.5,
  CPA_VERDE:       45000,
  CPA_PROMETEDOR:  55000,
  CPA_ATENCION:    70000,
};

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

  const freqSnaps = snaps.slice(-CONFIG.FREQ_WINDOW_DAYS);
  const frecuencia = avg(freqSnaps, "frequency") ?? 0;
  const funnel = classifyFunnel(frecuencia);

  if (snaps.length < CONFIG.MIN_DAYS_TO_JUDGE || totalSpend <= 0) {
    return { funnel, status: "sin_evaluar", mensaje: "Sin datos suficientes para evaluar." };
  }

  const shortSnaps = snaps.slice(-CONFIG.SHORT_WINDOW_DAYS);
  const avgCPM = avg(shortSnaps, "cpm");
  const avgCPR = avg(shortSnaps, "cost_per_result");

  const campAvg = ctx.campaignSpendAvg?.[ad.campaign_name];
  // >= en lugar de > para que ads en campañas de 1 solo ad también puedan ser gasto alto
  const gastoAlto = campAvg != null && campAvg > 0 && totalSpend >= campAvg;
  const gastoBajo = !gastoAlto;

  const freqBaja = frecuencia <= CONFIG.FREQ_TOFU_MAX;
  const freqAlta = frecuencia >= CONFIG.FREQ_BOFU_MIN;
  const cpmBajo  = avgCPM != null && avgCPM <  CONFIG.CPM_THRESHOLD;
  const cpmAlto  = avgCPM != null && avgCPM >= CONFIG.CPM_THRESHOLD;

  const costoBueno      = avgCPR != null && avgCPR <= CONFIG.CPA_VERDE;
  const costoPrometedor = avgCPR != null && avgCPR >  CONFIG.CPA_VERDE     && avgCPR <= CONFIG.CPA_PROMETEDOR;
  const costoAtencion   = avgCPR != null && avgCPR >  CONFIG.CPA_PROMETEDOR && avgCPR <= CONFIG.CPA_ATENCION;
  const sinDatos        = avgCPR == null;

  // 1. Tractor
  if (gastoAlto && freqBaja && cpmBajo && costoBueno)
    return { funnel, status: "tractor", mensaje: "El Tractor — Meta lo favorece, llega a gente nueva y convierte. Escalá." };

  // 2. Prometedor
  if (gastoAlto && freqBaja && cpmBajo && costoPrometedor)
    return { funnel, status: "prometedor", mensaje: "Prometedor — casi un Tractor, CPA en amarillo. Optimizá y puede escalar." };

  // 3. Atención
  if (gastoAlto && costoAtencion)
    return { funnel, status: "atencion", mensaje: "Atención — gastás plata pero el CPA está caro. Decidí si pausás o seguís mirando." };

  // 4. Cerrador
  if (gastoAlto && freqAlta && cpmAlto && costoBueno)
    return { funnel, status: "cerrador", mensaje: "El Cerrador — cierra bien en audiencia caliente. No escala en frío." };

  // 5. No suma
  if (gastoBajo && freqBaja && cpmAlto && sinDatos)
    return { funnel, status: "no_suma", mensaje: "El que no suma — Meta no lo favorece, caro y sin conversiones. Revisar o pausar." };

  // 6. Sin evaluar
  return { funnel, status: "sin_evaluar", mensaje: "Sin evaluar — no encaja en ningún patrón definido aún." };
}
