import { EmbedBuilder } from "discord.js";
import { type Action, actionInfo, PROPOSAL_TTL_MS } from "./actions";
import { config } from "./config";
import type { Expiry } from "./expiries";
import { madrid } from "./format";
import type { Anomaly } from "./logs";
import type { Notable } from "./attacks";

/**
 * Todo lo que manda el bot va en embeds: color según el estado y un pie
 * discreto. Mismos colores que los DMs de discord-dm y del vigilante.
 */
export const COLORS = {
  blue: 0x3b82f6,
  green: 0x22c55e,
  amber: 0xf59e0b,
  red: 0xef4444,
  grey: 0x6b7280,
} as const;

/** Límite de la descripción de un embed (4096) con margen. */
const MAX_DESCRIPTION = 4000;
/** Discord admite 10 embeds por mensaje y 6000 caracteres en total. */
const MAX_TOTAL = 5800;

function footer() {
  return { text: `Asistente · ${config.model.replace(/^.*\//, "")}` };
}

/** Trocea un texto largo por líneas para que quepa en descripciones de embed. */
export function splitForEmbeds(text: string, max = MAX_DESCRIPTION): string[] {
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > max && current) {
      parts.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line.slice(0, max);
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : ["_(sin contenido)_"];
}

/**
 * Embeds para un texto, agrupados en mensajes que respetan los límites de
 * Discord. Solo el primero lleva título y solo el último, pie y hora.
 */
export function textEmbeds(
  text: string,
  opts: { title?: string; color?: number } = {},
): EmbedBuilder[][] {
  const parts = splitForEmbeds(text);
  const messages: EmbedBuilder[][] = [[]];
  let size = 0;
  parts.forEach((part, i) => {
    const e = new EmbedBuilder().setColor(opts.color ?? COLORS.blue).setDescription(part);
    if (i === 0 && opts.title) e.setTitle(opts.title);
    if (i === parts.length - 1) e.setFooter(footer()).setTimestamp(new Date());
    const current = messages[messages.length - 1] ?? [];
    if (current.length === 10 || size + part.length > MAX_TOTAL) {
      messages.push([e]);
      size = part.length;
    } else {
      current.push(e);
      size += part.length;
    }
  });
  return messages;
}

/** Resumen diario: verde si todo va bien, ámbar si hay algo que mirar. */
export function summaryEmbeds(text: string, now = new Date()): EmbedBuilder[][] {
  const firstLine = text.trim().split("\n")[0]?.toLowerCase() ?? "";
  const allGood = firstLine.includes("todo en orden") || firstLine.includes("todo bien");
  const day = madrid(now).replace(/,\s*\d{2}:\d{2}$/, "");
  return textEmbeds(text, {
    title: `☀️ Resumen de la mañana · ${day}`,
    color: allGood ? COLORS.green : COLORS.amber,
  });
}

export function errorEmbed(text: string): EmbedBuilder {
  return new EmbedBuilder().setColor(COLORS.red).setDescription(text).setFooter(footer());
}

export type ProposalState =
  | { state: "pending" }
  | { state: "running" }
  | { state: "done"; ok: boolean; result: string }
  | { state: "cancelled" }
  | { state: "expired" };

/** El embed de una propuesta en cada momento: pendiente → ejecutando → resultado. */
export function proposalEmbed(action: Action, s: ProposalState): EmbedBuilder {
  const { title, detail } = actionInfo(action);
  const e = new EmbedBuilder().setTitle(title).setDescription(detail);
  switch (s.state) {
    case "pending":
      return e
        .setColor(COLORS.blue)
        .setFooter({ text: `Caduca en ${PROPOSAL_TTL_MS / 60_000} min · solo tú puedes confirmarla` });
    case "running":
      return e.setColor(COLORS.amber).addFields({ name: "Estado", value: "⏳ Ejecutando…" });
    case "done":
      return e
        .setColor(s.ok ? COLORS.green : COLORS.red)
        .addFields({ name: "Resultado", value: s.result.slice(0, 1024) })
        .setTimestamp(new Date());
    case "cancelled":
      return e.setColor(COLORS.grey).addFields({ name: "Estado", value: "❌ Cancelada" });
    case "expired":
      return e.setColor(COLORS.grey).addFields({ name: "Estado", value: "⌛ Caducada o ya usada. Pídemelo otra vez." });
  }
}

/** Cuántas anomalías caben en un aviso (y en el customId del botón de silenciar). */
export const MAX_ANOMALIES_SHOWN = 8;

/** Aviso de logs: patrones nuevos o que se disparan. */
export function anomaliesEmbed(anomalies: Anomaly[]): EmbedBuilder {
  const shown = anomalies.slice(0, MAX_ANOMALIES_SHOWN);
  const nuevos = anomalies.filter((a) => a.kind === "nuevo").length;
  const picos = anomalies.length - nuevos;
  const title = [nuevos && `${nuevos} ${nuevos === 1 ? "patrón nuevo" : "patrones nuevos"}`, picos && `${picos} ${picos === 1 ? "pico" : "picos"}`]
    .filter(Boolean)
    .join(" y ");
  const e = new EmbedBuilder()
    .setColor(COLORS.amber)
    .setTitle(`🔎 Logs: ${title}`)
    .setFields(
      shown.map((a) => ({
        name:
          a.kind === "nuevo"
            ? `🆕 ${a.unit} · ${a.count} ${a.count === 1 ? "vez" : "veces"}`
            : `📈 ${a.unit} · ${a.count}/h (normal ~${a.baseline}/h)`,
        value: `\`\`\`\n${a.sample.replace(/`/g, "'").slice(0, 300)}\n\`\`\`huella \`${a.fp}\``.slice(0, 1024),
      })),
    )
    .setFooter({ text: "Pregúntame qué significa · 🔕 deja de avisar de estos" })
    .setTimestamp(new Date());
  if (anomalies.length > shown.length) {
    e.setDescription(`…y ${anomalies.length - shown.length} más: pregúntame por los logs.`);
  }
  return e;
}

/** Aviso de caducidades que acaban de cruzar un umbral. */
export function expiriesEmbed(items: Array<Expiry & { threshold: number }>): EmbedBuilder {
  const urgent = items.some((i) => i.days_left <= 7);
  const line = (i: Expiry) => {
    const when = i.days_left < 0 ? `**caducó hace ${-i.days_left} días**` : i.days_left === 0 ? "**caduca hoy**" : `en **${i.days_left} días**`;
    const hint = i.kind === "certificado" ? " · certbot debería haberlo renovado: `certbot renew --dry-run`" : "";
    return `• ${i.what}: ${when} (${i.day})${hint}${i.notes ? `\n  _${i.notes}_` : ""}`;
  };
  return new EmbedBuilder()
    .setColor(urgent ? COLORS.red : COLORS.amber)
    .setTitle("⏰ Caducidades")
    .setDescription(items.map(line).join("\n").slice(0, MAX_DESCRIPTION))
    .setFooter(footer())
    .setTimestamp(new Date());
}

/** El honeypot ha cazado una descarga nueva (casi siempre malware). URL desactivada. */
export function downloadsEmbed(items: Notable[]): EmbedBuilder {
  const defang = (url: string) => url.replace(/^http/i, "hxxp").replace(/\./g, "[.]");
  return new EmbedBuilder()
    .setColor(COLORS.red)
    .setTitle(`🪤 El honeypot ha cazado ${items.length === 1 ? "una descarga" : `${items.length} descargas`}`)
    .setDescription(
      items
        .slice(0, 8)
        .map((i) => `• \`${defang(i.url).slice(0, 200)}\`\n  desde ${i.ip}${i.country ? ` (${i.country})` : ""}${i.sha256 ? ` · sha256 \`${i.sha256.slice(0, 16)}…\`` : ""}`)
        .join("\n")
        .slice(0, MAX_DESCRIPTION),
    )
    .setFooter({ text: "Está en el honeypot, no en el servidor real. Míralo en la oficina." })
    .setTimestamp(new Date());
}
