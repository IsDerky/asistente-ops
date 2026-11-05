import { readFile } from "node:fs/promises";
import { config } from "./config";

/**
 * Fuentes de datos del asistente. Ninguna necesita privilegios:
 *  - snapshot.json del recolector (root lo escribe, el grupo opsbot lo lee)
 *  - API interna de Bentonime (/api/ops/summary, token propio)
 *  - estado del vigilante externo (Worker de Cloudflare)
 * Cada función devuelve `{ error }` en vez de lanzar: una fuente caída no
 * debe impedir responder con las demás.
 */

/**
 * Cómo acabó el último despliegue de Bentonime (lo escribe
 * scripts/deploy-release.sh en ~bentonime/apps/last-deploy.json y lo lee el
 * recolector). `phase` = "ok" si fue bien; si no, la fase en la que falló.
 * `rollback`: "ok" | "fallida" | "" (no hizo falta o no había versión anterior).
 */
export interface LastDeploy {
  sha: string;
  phase: string;
  previous: string;
  rollback: string;
  at: string;
}

export interface Snapshot {
  collected_at: string;
  system: {
    hostname?: string;
    uptime_s?: number;
    load?: number[];
    cpus?: number;
    mem_total?: number;
    mem_available?: number;
    swap_used?: number;
    disks?: Record<string, { total: number; used: number; free: number }>;
    error?: string;
  };
  smart: Record<string, unknown>;
  services: Record<string, Record<string, string | number>> | { error: string };
  backups: Record<string, Record<string, string | number>> | { error: string };
  containers: ContainerStat[] | { error: string };
  /** Por nombre de certificado de Let's Encrypt. Falta en snapshots antiguos. */
  certificates?: Record<string, { expires_at?: string; error?: string }> | { error: string };
  /** Último simulacro de restauración (lo escribe `server-backup simulacro`). */
  simulacro?: Simulacro | { error: string };
  deploys?: { runner_busy?: boolean; bentonime_release?: string; bentonime_deployed_at?: string; last_deploy?: LastDeploy } | { error: string };
  /** Servidores de este nodo según Wings (estado y consumo). */
  wings?: import("./ptero").WingsServer[] | { error: string };
  /** Servidores de los otros nodos (tokens puestos a mano en /etc/ops-collect/wings-nodes.env), por dominio. */
  wings_remote?: Record<string, { servers?: import("./ptero").WingsServer[]; error?: string }> | { error: string };
  /** Por jail: IPs baneadas ahora y total histórico. */
  fail2ban?: Record<string, { banned: string[]; total_banned: number }> | { error: string };
}

export interface Simulacro {
  at: string;
  ok: boolean;
  /** Si falló, en qué paso. */
  step?: string;
  duration_s?: number;
  checks?: Record<string, string | number>;
}

export interface ContainerStat {
  container: string;
  server: string | null;
  cpu_pct: number;
  mem_bytes: number | null;
  mem_limit_bytes: number | null;
}

export type Result<T> = T | { error: string };

export function isError(v: unknown): v is { error: string } {
  return typeof v === "object" && v !== null && "error" in v && !Array.isArray(v);
}

/** Un snapshot de más de 15 min significa que el recolector no está corriendo. */
const STALE_MS = 15 * 60_000;

export async function readSnapshot(path = config.snapshotPath): Promise<Result<Snapshot>> {
  try {
    const snap = JSON.parse(await readFile(path, "utf8")) as Snapshot;
    const age = Date.now() - Date.parse(snap.collected_at);
    if (age > STALE_MS) {
      return { error: `el recolector no actualiza desde hace ${Math.round(age / 60_000)} min` };
    }
    return snap;
  } catch (err) {
    return { error: `no se pudo leer ${path}: ${(err as Error).message}` };
  }
}

async function request(
  url: string,
  token: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<Result<unknown>> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      return { error: `${new URL(url).host} respondió ${res.status}${body?.error ? `: ${body.error}` : ""}` };
    }
    return body;
  } catch (err) {
    return { error: `${new URL(url).host} no responde: ${(err as Error).message}` };
  }
}

const getJson = (url: string, token: string) => request(url, token);

/** Llamada a la API de ops de Bentonime; desenvuelve su `{ data }`. */
async function bentonime(path: string, init?: RequestInit, timeoutMs?: number): Promise<Result<unknown>> {
  if (!config.bentonimeToken) return { error: "OPS_API_TOKEN no configurado" };
  const res = await request(`${config.bentonimeUrl}/api/ops${path}`, config.bentonimeToken, init, timeoutMs);
  if (!isError(res) && typeof res === "object" && res !== null && "data" in res) {
    return (res as { data: unknown }).data;
  }
  return res;
}

export const bentonimeSummary = (hours = 24) => bentonime(`/summary?hours=${hours}`);

export const bentonimeSearch = (q: string) => bentonime(`/anime?q=${encodeURIComponent(q)}`, {}, 60_000);

/** Sincroniza la lista de episodios con la fuente: puede tardar. */
export const bentonimeAnime = (slug: string) =>
  bentonime(`/anime/${encodeURIComponent(slug)}`, {}, 90_000) as Promise<
    Result<{
      slug: string;
      title: string;
      totalEpisodes: number | null;
      episodesAvailable: number;
      downloaded: string;
      inQueue: string;
      canQueue: string;
    }>
  >;

export const bentonimeEnqueue = (slug: string, episodes: number[], priority = 3) =>
  bentonime(
    "/enqueue",
    { method: "POST", body: JSON.stringify({ slug, episodes, priority }) },
    90_000,
  ) as Promise<
    Result<{ title: string; queued: number; alreadyQueued: number; alreadyDownloaded: number; notFound: number }>
  >;

export async function watchdogStatus(): Promise<Result<unknown>> {
  if (!config.watchdogUrl) return { error: "OPS_WATCHDOG_URL no configurado" };
  return getJson(`${config.watchdogUrl.replace(/\/$/, "")}/status`, config.watchdogToken);
}
