import { type Alert, formatDuration } from "./watchdog";

const API = "https://discord.com/api/v10";
const RED = 0xef4444;
const AMBER = 0xf59e0b;
const GREEN = 0x22c55e;

export function alertEmbed(alert: Alert, now: number) {
  const { check } = alert;
  const ts = new Date(now).toISOString();
  if (alert.kind === "recovered") {
    return {
      title: `✅ ${check.label}: vuelve a responder`,
      description: `Ha estado ${formatDuration(alert.minutes)} sin dar señales.`,
      color: GREEN,
      footer: { text: "Vigilante externo · Cloudflare" },
      timestamp: ts,
    };
  }
  return {
    title: `${alert.kind === "down" ? "🚨" : "⏰"} ${check.label}: sin señales`,
    description: check.hint,
    color: alert.kind === "down" ? RED : AMBER,
    fields: [
      { name: "Última señal hace", value: formatDuration(alert.minutes), inline: true },
      { name: "Límite", value: formatDuration(check.maxSilenceMin), inline: true },
    ],
    footer: { text: "Vigilante externo · Cloudflare" },
    timestamp: ts,
  };
}

/** DM al owner con el mismo bot que usa el servidor (`discord-dm`). */
export async function sendDm(botToken: string, userId: string, embed: object): Promise<void> {
  const headers = { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" };
  const ch = await fetch(`${API}/users/@me/channels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!ch.ok) throw new Error(`Discord: no se pudo abrir el DM (${ch.status})`);
  const { id } = (await ch.json()) as { id: string };
  const msg = await fetch(`${API}/channels/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
  });
  if (!msg.ok) throw new Error(`Discord: no se pudo enviar el DM (${msg.status})`);
}
