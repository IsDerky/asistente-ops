import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config";
import type { Ctx } from "./context";
import { bentonimeEnqueue, isError } from "./data";
import type { NewIncident } from "./incidents";

/**
 * Acciones que el asistente puede PROPONER. Nunca se ejecutan solas: el bot
 * manda un mensaje con botones y solo al pulsar "Confirmar" (el owner, antes
 * de que caduque) se ejecutan. Lista cerrada a propósito; nada toca los
 * servidores de Pterodactyl de los clientes.
 *
 * Permisos: el bot corre como `opsbot` sin sudo. Una regla de polkit
 * (deploy/50-asistente.rules) le deja SOLO reiniciar bentonime.service y
 * arrancar server-backup@sistema.service. Apuntar un incidente solo escribe
 * en la base de datos del propio bot.
 */
export type Action =
  | { kind: "reiniciar_bentonime" }
  | { kind: "backup_sistema" }
  | { kind: "encolar_episodios"; slug: string; title: string; episodes: number[] }
  | ({ kind: "registrar_incidente" } & NewIncident);

/** Las que se piden con proponer_accion; el incidente tiene su propia herramienta. */
export const ACTION_KINDS = ["reiniciar_bentonime", "backup_sistema", "encolar_episodios"] as const;

/** Tiempo para pulsar Confirmar; después la propuesta caduca. */
export const PROPOSAL_TTL_MS = 10 * 60_000;

/** Título y detalle de una acción, para el embed de la propuesta. */
export function actionInfo(a: Action): { title: string; detail: string } {
  switch (a.kind) {
    case "reiniciar_bentonime":
      return {
        title: "🔄 Reiniciar Bentonime",
        detail: "Se corta unos segundos; después compruebo que vuelve a responder.",
      };
    case "backup_sistema":
      return {
        title: "💾 Backup de sistema ahora",
        detail: "Restic a Google Drive; suele tardar pocos minutos.",
      };
    case "encolar_episodios":
      return {
        title: "📥 Encolar en Bentonime",
        detail: `**${a.title}**\nEpisodios ${compact(a.episodes)} (${a.episodes.length})`,
      };
    case "registrar_incidente":
      return {
        title: "📓 Apuntar incidente",
        detail: `**${a.title}** (${a.day})\n**Síntoma:** ${a.symptom}\n**Causa:** ${a.cause}\n**Solución:** ${a.solution}`.slice(
          0,
          3900,
        ),
      };
  }
}

/** Una línea legible (para el resultado de la herramienta y los logs). */
export function describeAction(a: Action): string {
  const { title, detail } = actionInfo(a);
  return `${title}: ${detail.replace(/\*\*/g, "").replace(/\n/g, ", ")}`;
}

export function compact(numbers: number[]): string {
  const s = [...new Set(numbers)].sort((x, y) => x - y);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === (s[j] ?? 0) + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

const exec = promisify(execFile);

async function systemctl(...args: string[]): Promise<void> {
  // --no-ask-password: sin la regla de polkit, falla en vez de quedarse esperando.
  await exec("systemctl", ["--no-ask-password", ...args], { timeout: 60_000 });
}

async function bentonimeHealthy(timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${config.bentonimeUrl}/api/health`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) return true;
    } catch {
      // aún arrancando
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

export interface ActionResult {
  ok: boolean;
  text: string;
}

/** Ejecuta una acción ya confirmada. Los fallos de systemctl se lanzan. */
export async function runAction(a: Action, ctx: Pick<Ctx, "incidents">): Promise<ActionResult> {
  switch (a.kind) {
    case "reiniciar_bentonime": {
      const start = Date.now();
      await systemctl("restart", "bentonime.service");
      const ok = await bentonimeHealthy();
      const secs = Math.round((Date.now() - start) / 1000);
      return ok
        ? { ok, text: `✅ Reiniciado y respondiendo en ${secs} s.` }
        : {
            ok,
            text: "⚠️ Se ha reiniciado pero no responde a /api/health tras 90 s. Mira `journalctl -u bentonime -n 50`.",
          };
    }
    case "backup_sistema":
      await systemctl("start", "--no-block", "server-backup@sistema.service");
      return {
        ok: true,
        text: "✅ Lanzado. Si falla te llegará el DM de siempre; si va bien, el vigilante recibirá su señal.",
      };
    case "encolar_episodios": {
      const r = await bentonimeEnqueue(a.slug, a.episodes);
      if (isError(r)) return { ok: false, text: `⚠️ No se ha podido encolar: ${r.error}` };
      const parts = [`${r.queued} en cola`];
      if (r.alreadyQueued) parts.push(`${r.alreadyQueued} ya estaban en cola`);
      if (r.alreadyDownloaded) parts.push(`${r.alreadyDownloaded} ya descargados`);
      if (r.notFound) parts.push(`${r.notFound} no existen`);
      return { ok: r.notFound === 0, text: `✅ ${parts.join(", ")}.` };
    }
    case "registrar_incidente": {
      const { kind: _, ...incident } = a;
      const id = ctx.incidents.add(incident);
      return { ok: true, text: `✅ Apuntado como incidente #${id}.` };
    }
  }
}

interface Pending {
  action: Action;
  createdAt: number;
}

/**
 * Propuestas a la espera de un botón. En memoria a propósito: si el bot se
 * reinicia, las propuestas viejas caducan y hay que pedirlo otra vez.
 */
export class PendingActions {
  private readonly items = new Map<string, Pending>();

  add(action: Action, now = Date.now()): string {
    this.prune(now);
    const id = randomBytes(6).toString("hex");
    this.items.set(id, { action, createdAt: now });
    return id;
  }

  /**
   * Saca la propuesta (una sola vez: un doble clic no la ejecuta dos veces).
   * null si no existe o ha caducado.
   */
  take(id: string, now = Date.now()): Action | null {
    const p = this.items.get(id);
    this.items.delete(id);
    if (!p || now - p.createdAt > PROPOSAL_TTL_MS) return null;
    return p.action;
  }

  private prune(now: number) {
    for (const [id, p] of this.items) {
      if (now - p.createdAt > PROPOSAL_TTL_MS) this.items.delete(id);
    }
  }
}
