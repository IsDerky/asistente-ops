import type { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LastDeploy } from "./data";

/**
 * Eventos de la oficina: cosas concretas que acaban de pasar ("empieza el
 * backup", "se ha descargado el episodio 4 de X", "fail2ban banea a una IP").
 * Salen de comparar cada foto con la anterior; la oficina los convierte en
 * escenas (alguien coge el ascensor, llega la furgoneta…). Se guardan los
 * últimos 500 para el registro "Lo que acaba de pasar".
 */
export type Level = "info" | "ok" | "warn" | "error";

export interface OfficeEvent {
  id: number;
  ts: number;
  type: string;
  level: Level;
  text: string;
  data?: Record<string, unknown>;
}

export type NewEvent = Omit<OfficeEvent, "id" | "ts"> & { ts?: number };

const KEEP = 500;

export class EventLog {
  private listeners = new Set<(e: OfficeEvent) => void>();

  constructor(readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS office_event (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        text TEXT NOT NULL,
        data TEXT
      );
    `);
  }

  push(e: NewEvent): OfficeEvent {
    const ts = e.ts ?? Date.now();
    const id = Number(
      this.db
        .prepare("INSERT INTO office_event (ts, type, level, text, data) VALUES (?, ?, ?, ?, ?)")
        .run(ts, e.type, e.level, e.text, e.data ? JSON.stringify(e.data) : null).lastInsertRowid,
    );
    this.db.run(`DELETE FROM office_event WHERE id <= ? - ${KEEP}`, [id]);
    const full: OfficeEvent = { id, ts, type: e.type, level: e.level, text: e.text, ...(e.data ? { data: e.data } : {}) };
    for (const l of this.listeners) l(full);
    return full;
  }

  onEvent(fn: (e: OfficeEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  recent(limit = 60): OfficeEvent[] {
    const rows = this.db
      .query("SELECT id, ts, type, level, text, data FROM office_event ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<Omit<OfficeEvent, "data"> & { data: string | null }>;
    return rows.map(({ data, ...r }) => ({ ...r, ...(data ? { data: JSON.parse(data) as Record<string, unknown> } : {}) }));
  }

  /** Veces que ha pasado algo desde `sinceMs` (p. ej. backups hechos hoy). */
  count(type: string, sinceMs: number): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM office_event WHERE type = ? AND ts >= ?").get(type, sinceMs) as { n: number }).n;
  }
}

// --- Lo que se compara ------------------------------------------------------------

export interface UnitState {
  active: string;
  result: string;
  exitTs: number;
}

export interface Live {
  units: Record<string, UnitState>;
  runnerBusy: boolean;
  downloads: {
    running: number;
    queued: number;
    episodes: Array<{ anime: string; slug: string; number: number; downloaded: boolean }>;
    failures: Array<{ anime: string; number: number; at: string }>;
  } | null;
  /** Quién está viendo Bentonime ahora (clave opaca y nombre). Falta con un Bentonime antiguo. */
  viewers?: Array<{ key: string; name: string }> | null;
  /** Logins rechazados por la lista blanca (últimas 24 h). */
  rejections?: Array<{ name: string; at: string }> | null;
}

const BACKUP_MODES = ["sistema", "clientes", "mantenimiento", "simulacro"] as const;
/** Servicios cuya caída se ve en la oficina, con la planta a la que afecta. */
export const WATCHED: Record<string, string> = {
  "bentonime.service": "Bentonime",
  "nginx.service": "nginx",
  "wings.service": "Wings",
  "cloudflared.service": "el túnel de Cloudflare",
  "mariadb.service": "MariaDB",
  "docker.service": "Docker",
  "fail2ban.service": "fail2ban",
  "honeypot.service": "el honeypot",
};
export const UNITS = [...BACKUP_MODES.map((m) => `server-backup@${m}.service`), ...Object.keys(WATCHED)];

const MODE_LABEL: Record<string, string> = {
  sistema: "de sistema",
  clientes: "de clientes",
  mantenimiento: "el mantenimiento de backups",
  simulacro: "el simulacro de restauración",
};

/** Qué ha pasado entre dos fotos. Puro, para poder probarlo. */
export function diffLive(prev: Live | null, cur: Live): NewEvent[] {
  if (!prev) return [];
  const out: NewEvent[] = [];

  for (const mode of BACKUP_MODES) {
    const unit = `server-backup@${mode}.service`;
    const a = prev.units[unit];
    const b = cur.units[unit];
    if (!a || !b) continue;
    const what = mode === "sistema" || mode === "clientes" ? `el backup ${MODE_LABEL[mode]}` : MODE_LABEL[mode];
    if (a.active !== "activating" && b.active === "activating") {
      out.push({ type: "backup.start", level: "info", text: `Empieza ${what}`, data: { mode } });
    }
    const finished = (a.active === "activating" && b.active !== "activating") || (b.exitTs > a.exitTs && b.active !== "activating");
    if (finished) {
      const ok = b.result === "success";
      out.push({
        type: ok ? "backup.ok" : "backup.fail",
        level: ok ? "ok" : "error",
        text: ok ? `Terminado ${what}` : `Ha fallado ${what} (${b.result})`,
        data: { mode },
      });
    }
  }

  for (const [unit, label] of Object.entries(WATCHED)) {
    const a = prev.units[unit];
    const b = cur.units[unit];
    if (!a || !b) continue;
    const was = a.active === "active";
    const is = b.active === "active";
    if (was && !is) out.push({ type: "service.down", level: "error", text: `Se ha caído ${label}`, data: { unit } });
    if (!was && is) out.push({ type: "service.up", level: "ok", text: `Vuelve ${label}`, data: { unit } });
  }

  if (!prev.runnerBusy && cur.runnerBusy) {
    out.push({ type: "deploy.start", level: "info", text: "Llega una versión nueva de Bentonime" });
  }

  const pd = prev.downloads;
  const cd = cur.downloads;
  if (pd && cd) {
    if (pd.running === 0 && cd.running > 0) {
      out.push({ type: "download.start", level: "info", text: `Empieza a descargar (${cd.queued} en cola)` });
    }
    const key = (e: { slug?: string; anime: string; number: number }) => `${e.slug ?? e.anime}#${e.number}`;
    const before = new Map(pd.episodes.map((e) => [key(e), e]));
    for (const e of cd.episodes) {
      const old = before.get(key(e));
      if (!old) {
        out.push({ type: "episode.new", level: "info", text: `Nuevo: ${e.anime}, episodio ${e.number}`, data: { anime: e.anime, number: e.number } });
      } else if (!old.downloaded && e.downloaded) {
        out.push({ type: "download.done", level: "ok", text: `Listo para ver: ${e.anime}, episodio ${e.number}`, data: { anime: e.anime, number: e.number } });
      }
    }
    const seenFail = new Set(pd.failures.map((f) => `${f.anime}#${f.number}#${f.at}`));
    for (const f of cd.failures) {
      if (!seenFail.has(`${f.anime}#${f.number}#${f.at}`)) {
        out.push({ type: "download.fail", level: "warn", text: `No se pudo descargar ${f.anime}, episodio ${f.number}`, data: { anime: f.anime, number: f.number } });
      }
    }
  }
  // Espectadores de Bentonime: la oficina los sienta (por el estado); aquí, el registro.
  if (prev.viewers && cur.viewers) {
    const before = new Set(prev.viewers.map((v) => v.key));
    const now = new Set(cur.viewers.map((v) => v.key));
    for (const v of cur.viewers) {
      if (!before.has(v.key)) out.push({ type: "viewer.arrive", level: "info", text: `${v.name} se pone a ver Bentonime`, data: { key: v.key, name: v.name } });
    }
    for (const v of prev.viewers) {
      if (!now.has(v.key)) out.push({ type: "viewer.leave", level: "info", text: `${v.name} deja de ver Bentonime`, data: { key: v.key, name: v.name } });
    }
  }
  if (prev.rejections && cur.rejections) {
    const seen = new Set(prev.rejections.map((r) => `${r.name}#${r.at}`));
    for (const r of [...cur.rejections].reverse()) {
      if (!seen.has(`${r.name}#${r.at}`)) {
        out.push({ type: "viewer.rejected", level: "warn", text: `${r.name} intenta entrar en Bentonime y no está en la lista`, data: { name: r.name } });
      }
    }
  }
  return out;
}

// --- Lectura en vivo (sin root) ------------------------------------------------------

const exec = promisify(execFile);

/** `systemctl show` de varias unidades; no necesita privilegios. */
export async function unitStates(units = UNITS): Promise<Record<string, UnitState>> {
  const { stdout } = await exec(
    "systemctl",
    ["show", ...units, "--timestamp=unix", "-p", "Id,ActiveState,Result,ExecMainExitTimestamp"],
    { timeout: 10_000 },
  );
  const out: Record<string, UnitState> = {};
  for (const block of stdout.split(/\n\s*\n/)) {
    const kv = Object.fromEntries(
      block
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    if (!kv.Id) continue;
    out[kv.Id] = {
      active: kv.ActiveState ?? "unknown",
      result: kv.Result ?? "",
      exitTs: Number((kv.ExecMainExitTimestamp ?? "").replace("@", "")) || 0,
    };
  }
  return out;
}

export async function runnerBusy(): Promise<boolean> {
  try {
    await exec("pgrep", ["-f", "Runner.Worker"], { timeout: 5_000 });
    return true;
  } catch {
    return false; // pgrep sale con 1 si no hay ninguno
  }
}

// --- Lo que solo sabe el recolector (cada 5 min) ------------------------------------------

export interface SnapFacts {
  release: string | null;
  /** Falta en hechos de antes de que el script de deploy lo escribiera. */
  lastDeploy?: LastDeploy | null;
  /** Caducidad (ISO) de cada certificado de Let's Encrypt: si avanza, certbot lo ha renovado. */
  certs?: Record<string, string>;
  banned: string[];
}

/** Qué decir de un despliegue que no acabó bien. */
function deployFailText(d: LastDeploy): string {
  const sha = d.sha.slice(0, 7);
  if (d.rollback === "ok") return `Falló el despliegue de ${sha} (${d.phase}): vuelta a ${d.previous}`;
  if (d.rollback === "fallida") return `Falló el despliegue de ${sha} y la versión anterior tampoco responde`;
  return `Falló el despliegue de ${sha} (${d.phase}); sigue la versión de antes`;
}

/** Versión desplegada y baneos nuevos de fail2ban. `country` pone el país a cada IP. */
export function diffSnap(prev: SnapFacts | null, cur: SnapFacts, country: (ip: string) => string | null = () => null): NewEvent[] {
  if (!prev) return [];
  const out: NewEvent[] = [];
  if (prev.release && cur.release && prev.release !== cur.release) {
    out.push({ type: "deploy.done", level: "ok", text: `Bentonime actualizado a la versión ${cur.release.slice(0, 7)}`, data: { release: cur.release } });
  }
  for (const [name, until] of Object.entries(cur.certs ?? {})) {
    const before = prev.certs?.[name];
    if (before && until > before) {
      out.push({ type: "cert.renewed", level: "ok", text: `certbot renueva el certificado ${name} (hasta el ${until.slice(0, 10)})`, data: { name, until } });
    }
  }
  const d = cur.lastDeploy;
  if (d && d.at !== prev.lastDeploy?.at && d.phase !== "ok") {
    out.push({
      type: "deploy.fail",
      level: d.rollback === "fallida" ? "error" : "warn",
      text: deployFailText(d),
      data: { sha: d.sha, phase: d.phase, rollback: d.rollback, previous: d.previous },
    });
  }
  const before = new Set(prev.banned);
  const fresh = cur.banned.filter((ip) => !before.has(ip));
  for (const ip of fresh.slice(0, 5)) {
    const c = country(ip);
    out.push({ type: "ban", level: "ok", text: `fail2ban echa a ${ip}${c ? ` (${c})` : ""}`, data: { ip, country: c } });
  }
  if (fresh.length > 5) {
    out.push({ type: "ban", level: "ok", text: `…y a ${fresh.length - 5} IPs más`, data: { more: fresh.length - 5 } });
  }
  return out;
}
