import { createHash, timingSafeEqual } from "node:crypto";
import type { NewEvent } from "./events";

/**
 * Sesiones de Claude Code del PC, para la oficina. Llegan por los hooks HTTP de
 * Claude Code (POST /api/claude/hook, solo desde el PC y con token). Del
 * payload, que trae prompts, comandos y contenido de archivos, solo se queda:
 * un id corto derivado del de la sesión, el nombre de la carpeta del proyecto,
 * el evento y el nombre de la herramienta. Todo en memoria: si el bot se
 * reinicia, cada sesión reaparece con su siguiente hook.
 */
export type ClaudeState = "working" | "needs_you" | "idle";

export interface ClaudeSession {
  id: string;
  project: string;
  state: ClaudeState;
  /** Herramienta en curso (Bash, Edit…) mientras trabaja. */
  tool: string | null;
  startedAt: number;
  /** Desde cuándo está en el estado actual. */
  since: number;
  lastSeen: number;
  /** Subagentes trabajando ahora (los becarios de su mesa). */
  subagents: number;
}

/** Sin hooks en este tiempo (VS Code cerrado sin SessionEnd), la sesión se da por terminada. */
export const STALE_MS = 6 * 3600_000;
/** Sitios en la planta: más sesiones a la vez no se pintan. */
export const MAX_SESSIONS = 4;

export interface HookPayload {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  tool_name?: unknown;
  notification_type?: unknown;
}

const clean = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[^\p{L}\p{N} ._\-()]/gu, "").slice(0, max) : "";

/** Último trozo de la ruta (Windows o POSIX): "MyOwnAnime", no la ruta entera. */
export function projectName(cwd: unknown): string {
  if (typeof cwd !== "string") return "?";
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return clean(parts.at(-1) ?? "", 40) || "?";
}

export function checkToken(header: string | null, token: string): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class ClaudeSessions {
  private readonly items = new Map<string, ClaudeSession>();

  /**
   * Sesiones con SessionStart y nada más. La extensión de VS Code abre y cierra
   * varias vacías al arrancar (en menos de un segundo): no se pintan ni van al
   * registro hasta que llega actividad de verdad (un prompt, una herramienta…).
   */
  private readonly quiet = new Set<string>();

  /** Tramos ya cerrados en los que alguna sesión trabajaba (para la pizarra del día). */
  private worked: Array<[number, number]> = [];

  private closeWork(s: ClaudeSession, end: number) {
    if (s.state !== "working" || end <= s.since) return;
    this.worked.push([s.since, end]);
    // Con dos días de tramos sobra para "hoy".
    const keepFrom = end - 2 * 24 * 3600_000;
    this.worked = this.worked.filter(([, e]) => e >= keepFrom);
  }

  /** Milisegundos trabajados desde `sinceMs` (sumando sesiones; incluye lo que está en curso). */
  workedSince(sinceMs: number, now = Date.now()): number {
    const open = [...this.items.values()].filter((s) => s.state === "working").map((s): [number, number] => [s.since, now]);
    return [...this.worked, ...open].reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, now) - Math.max(a, sinceMs)), 0);
  }

  list(now = Date.now()): ClaudeSession[] {
    for (const [id, s] of this.items) {
      if (now - s.lastSeen <= STALE_MS) continue;
      this.closeWork(s, s.lastSeen);
      this.items.delete(id);
      this.quiet.delete(id);
    }
    return [...this.items.values()]
      .filter((s) => !this.quiet.has(s.id))
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, MAX_SESSIONS);
  }

  /** Aplica un hook. Devuelve los eventos para el registro (solo los que importan). */
  hook(p: HookPayload, now = Date.now()): NewEvent[] {
    const raw = typeof p.session_id === "string" ? p.session_id : "";
    const event = typeof p.hook_event_name === "string" ? p.hook_event_name : "";
    if (!raw || !event) return [];
    const id = createHash("sha256").update(raw).digest("hex").slice(0, 8);
    const project = projectName(p.cwd);
    const at = (s: ClaudeSession) => ({ id: s.id, project: s.project });

    if (event === "SessionEnd") {
      const s = this.items.get(id);
      if (!s) return [];
      this.closeWork(s, now);
      this.items.delete(id);
      if (this.quiet.delete(id)) return [];
      return [{ type: "claude.end", level: "info", text: `Se cierra la sesión de Claude Code en ${s.project}`, data: at(s) }];
    }

    const out: NewEvent[] = [];
    let s = this.items.get(id);
    if (!s) {
      s = { id, project, state: "idle", tool: null, startedAt: now, since: now, lastSeen: now, subagents: 0 };
      this.items.set(id, s);
      this.quiet.add(id);
    }
    if (event !== "SessionStart" && this.quiet.delete(id)) {
      out.push({ type: "claude.start", level: "info", text: `Empieza una sesión de Claude Code en ${project}`, data: at(s) });
    }
    s.lastSeen = now;
    s.project = project;
    const set = (state: ClaudeState, tool: string | null = null) => {
      if (s.state !== state) {
        this.closeWork(s, now);
        s.since = now;
      }
      s.state = state;
      s.tool = tool;
    };

    switch (event) {
      case "UserPromptSubmit":
      case "PostToolUse":
      case "PostToolUseFailure":
        set("working", event === "UserPromptSubmit" ? null : s.tool);
        break;
      case "SubagentStart":
        s.subagents = Math.min(9, s.subagents + 1);
        set("working", s.tool);
        break;
      case "SubagentStop":
        s.subagents = Math.max(0, s.subagents - 1);
        set("working", s.tool);
        break;
      case "PreToolUse":
        set("working", clean(p.tool_name, 40) || null);
        break;
      case "PermissionRequest":
        if (s.state !== "needs_you") {
          out.push({ type: "claude.needs", level: "warn", text: `Claude Code te pide permiso en ${s.project}`, data: at(s) });
        }
        set("needs_you", s.tool);
        break;
      case "Notification":
        // Solo la de permiso: "idle_prompt" llega cuando ya se ha parado (Stop).
        if (p.notification_type === "permission_prompt" && s.state !== "needs_you") {
          out.push({ type: "claude.needs", level: "warn", text: `Claude Code te pide permiso en ${s.project}`, data: at(s) });
          set("needs_you", s.tool);
        }
        break;
      case "Stop": {
        const mins = Math.round((now - s.since) / 60_000);
        // Los turnos cortos solo cambian la postura; al registro van los de 1 min o más.
        if (s.state === "working" && mins >= 1) {
          out.push({ type: "claude.done", level: "ok", text: `Claude Code ha terminado en ${s.project} (${mins} min)`, data: at(s) });
        }
        set("idle");
        // Por si se perdió algún SubagentStop: al acabar el turno no queda ninguno.
        s.subagents = 0;
        break;
      }
    }
    return out;
  }
}
