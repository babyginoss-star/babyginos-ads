// ============================================================
//  Notificador de Telegram  (canal gratis para el resumen diario)
// ============================================================
// Necesitás: TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID (ver README).

export async function sendTelegram({ botToken, chatId, text }) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram: ${json.description}`);
  return json;
}

/**
 * Arma el texto del resumen diario a partir de los anuncios evaluados.
 */
export function buildDigest(evaluated) {
  const ganadores = evaluated.filter((e) => e.status === "ganador");
  const fatigando = evaluated.filter((e) => e.status === "fatigando");

  const line = (e) =>
    `• <b>${e.ad_code || e.ad_name}</b> [${e.funnel}] — ${e.mensaje}`;

  let out = `📊 <b>Baby Ginos · Resumen de anuncios</b>\n`;
  out += `${new Date().toLocaleDateString("es-AR")}\n\n`;

  out += `🏆 <b>Ganadores (${ganadores.length})</b>\n`;
  out += ganadores.length ? ganadores.map(line).join("\n") : "— ninguno hoy";
  out += `\n\n`;

  out += `⚠️ <b>Fatigando — acción (${fatigando.length})</b>\n`;
  out += fatigando.length ? fatigando.map(line).join("\n") : "— ninguno, todo sano";

  return out;
}
