import { readdirSync, statSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import type { ClaudeSession } from "./claude";
import { config } from "./config";
import type { Ctx } from "./context";
import { bentonimeSummary, isError, readSnapshot, type Snapshot, watchdogStatus } from "./data";
import { bytes, madrid } from "./format";
import { localWingsServers, wingsServers } from "./ptero";
import { simulacroView } from "./views";
import type { Music } from "./spotify";
import type { Weather } from "./weather";

/**
 * Lo que pinta la oficina (solo LAN): cada servicio es un personaje en su sala
 * con un estado de ánimo. Todo sale de las mismas fuentes que usa el bot; la
 * oficina no tiene permisos propios ni datos aparte.
 */
export type Mood = "idle" | "working" | "needs_you" | "error" | "away";

export interface Desk {
  id: string;
  room: string;
  name: string;
  mood: Mood;
  /** Una línea corta para el bocadillo. */
  status: string;
  details: Array<[string, string]>;
}

export interface InboxItem {
  from: string;
  level: "info" | "warn" | "error";
  text: string;
}

export interface OfficeState {
  at: string;
  server: Array<[string, string]>;
  desks: Desk[];
  /** state: running, starting, stopping, offline, suspended, unknown (sin datos de su nodo) o node_down. */
  racks: Array<{ name: string; owner: string | null; node: string | null; state: string; mem: number | null; limit: number | null; cpu: number }>;
  inbox: InboxItem[];
  /** Sesiones de Claude Code abiertas en el PC (secretaría, una mesa cada una). */
  claude: ClaudeSession[];
  /** Lo que la oficina dibuja siempre, no solo en las escenas. */
  scene: {
    /** IPs baneadas ahora (fail2ban): la lista negra de la puerta. */
    banned: { count: number; recent: string[] };
    /** Copias terminadas hoy (hora de Madrid): cajas en la cámara. */
    backupsToday: number;
    /** Servicios caídos ahora: alarma en su planta. */
    down: string[];
    downloading: number;
    queued: number;
    /** Caducidades a 7 días o menos: el calendario de la secretaría en rojo. */
    urgentExpiries: number;
    /** El nodo de Pterodactyl de este servidor: RAM prometida frente a la física. */
    node: { name: string; promisedGb: number; physicalGb: number | null; freePorts: number } | null;
    /** Todos los nodos del panel: si responden y si se conoce el estado de sus servidores. */
    nodes: Array<{ name: string; local: boolean; reachable: boolean | null; servers: number; live: boolean }>;
    /** El tiempo de ahora en las ventanas (null si no se sabe). */
    weather: Weather | null;
    /** Gente viendo algo en Bentonime ahora (butacas de la sala de proyección). */
    watching: number;
    /** Quiénes (clave opaca y nombre de Bentonime): cada uno entra por la puerta y se sienta. */
    viewers: Array<{ key: string; name: string }>;
    /** Pulso de la máquina (en directo): ventilador y termómetro de la sala de servidores. */
    pulse: { load1: number; cpus: number; ssdTempC: number | null };
    /** La pizarra de la secretaría: lo de hoy (desde medianoche de Madrid). */
    today: { attacks: number; bans: number; backups: number; deploys: number; claudeMinutes: number };
    /** Lo que suena en Spotify (null si no está configurado o no se sabe). */
    music: Music | null;
    /** Días que le quedan al certificado que antes caduca (cerradura oxidada si son pocos). */
    lockDays: number | null;
    /** Despliegues en marcha que ponen la oficina en obras (repo y desde cuándo). */
    works: Array<{ repo: string; since: number }>;
  };
}

/** Un archivo por despliegue en marcha (nombre = repo). Los de más de 2 h se dan por olvidados. */
export function readWorks(dir: string, now = Date.now()): Array<{ repo: string; since: number }> {
  try {
    return readdirSync(dir)
      .filter((name) => /^[a-z0-9._-]{1,40}$/i.test(name))
      .map((name) => ({ repo: name, since: statSync(join(dir, name)).mtimeMs }))
      .filter((w) => now - w.since < 2 * 3600_000);
  } catch {
    return []; // sin carpeta: nadie está desplegando
  }
}

function madridMidnight(now = Date.now()): number {
  const [h, m, s] = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .format(now)
    .split(":")
    .map(Number);
  return now - (((h ?? 0) * 60 + (m ?? 0)) * 60 + (s ?? 0)) * 1000;
}

const ago = (iso: string | number | undefined | null) => (iso ? madrid(iso) : "nunca");

interface UnitState {
  ActiveState?: string;
  Result?: string;
  ExecMainExitTimestamp?: number | string;
}

function backupsDesk(snap: Snapshot | null, inbox: InboxItem[]): Desk {
  const d: Desk = { id: "archivero", room: "archivo", name: "El archivero", mood: "idle", status: "Todo archivado", details: [] };
  if (!snap || isError(snap.backups)) {
    return { ...d, mood: "away", status: "No sé nada de los backups" };
  }
  const backups = snap.backups as Record<string, UnitState>;
  for (const [mode, st] of Object.entries(backups)) {
    const end = typeof st.ExecMainExitTimestamp === "number" && st.ExecMainExitTimestamp > 0 ? st.ExecMainExitTimestamp * 1000 : null;
    // Sin fecha de fin, systemd no la ha corrido desde el arranque (y su Result por defecto es "success").
    const last = end == null ? "sin ejecutar desde el arranque" : `${st.Result ?? "?"} · ${ago(end)}`;
    d.details.push([`Backup ${mode}`, st.ActiveState === "activating" ? "en marcha" : last]);
    if (st.ActiveState === "activating") {
      d.mood = "working";
      d.status = `Subiendo el backup de ${mode}…`;
    } else if (st.Result && st.Result !== "success") {
      d.mood = "error";
      d.status = `El backup de ${mode} ha fallado`;
      inbox.push({ from: d.name, level: "error", text: `Backup de ${mode}: ${st.Result}` });
    }
  }
  const sim = simulacroView(snap);
  if ("resultado" in sim) {
    d.details.push(["Simulacro", `${sim.resultado} · ${sim.cuando}`]);
    if (sim.resultado !== "superado") {
      d.mood = "error";
      d.status = "El simulacro de restauración ha fallado";
      inbox.push({ from: d.name, level: "error", text: `Simulacro: ${sim.resultado}` });
    } else if (sim.atrasado) {
      inbox.push({ from: d.name, level: "warn", text: `El último simulacro fue hace ${sim.hace_dias} días` });
    }
  } else {
    d.details.push(["Simulacro", "todavía ninguno"]);
  }
  return d;
}

async function bentonimeDesk(
  snap: Snapshot | null,
  inbox: InboxItem[],
  out: { viewers: Array<{ key: string; name: string }> },
): Promise<Desk> {
  const d: Desk = { id: "proyeccionista", room: "proyeccion", name: "El proyeccionista", mood: "idle", status: "Sala lista", details: [] };
  const svc = snap && !isError(snap.services) ? (snap.services as Record<string, UnitState>).bentonime : undefined;
  if (svc && svc.ActiveState !== "active") {
    inbox.push({ from: d.name, level: "error", text: `Bentonime está ${svc.ActiveState}` });
    return { ...d, mood: "error", status: "¡Bentonime no está en marcha!" };
  }
  const sum = (await bentonimeSummary(24)) as
    | {
        newEpisodes?: Array<{ anime: string; number: number; downloaded: boolean }>;
        downloads?: { byStatus?: Record<string, number>; recentFailures?: unknown[]; offlineBytes?: number };
        failingCrons?: Array<{ name: string }>;
        watchingNow?: number;
        watchers?: Array<{ key: string; name: string }>;
      }
    | { error: string };
  if (isError(sum)) return { ...d, mood: "away", status: "No me contesta la API", details: [["Error", sum.error]] };
  out.viewers = (sum.watchers ?? []).slice(0, 12).map((v) => ({ key: String(v.key).slice(0, 16), name: String(v.name).slice(0, 32) }));
  const by = sum.downloads?.byStatus ?? {};
  const running = (by.running ?? 0) + (by.downloading ?? 0);
  const queued = by.queued ?? by.pending ?? 0;
  const failures = sum.downloads?.recentFailures?.length ?? 0;
  d.details.push(
    ["Descargando", String(running)],
    ["En cola", String(queued)],
    ["Fallidas (24 h)", String(failures)],
    ["Offline", bytes(sum.downloads?.offlineBytes ?? 0)],
    ["Episodios nuevos (24 h)", String(sum.newEpisodes?.length ?? 0)],
    // Falta en un Bentonime de antes de watchingNow: entonces no se pinta nadie en las butacas.
    ["Viendo ahora", String(sum.watchingNow ?? 0)],
  );
  if (running > 0) {
    d.mood = "working";
    d.status = `Bajando ${running} episodio${running === 1 ? "" : "s"} (${queued} en cola)`;
  } else if (sum.newEpisodes?.length) {
    d.status = `${sum.newEpisodes.length} episodios nuevos hoy`;
  }
  if (failures > 0) {
    d.mood = d.mood === "working" ? "working" : "needs_you";
    d.status = `${failures} descarga${failures === 1 ? "" : "s"} fallida${failures === 1 ? "" : "s"}`;
    inbox.push({ from: d.name, level: "warn", text: d.status });
  }
  for (const c of sum.failingCrons ?? []) {
    d.mood = "needs_you";
    inbox.push({ from: d.name, level: "warn", text: `Cron con error: ${c.name}` });
  }
  return d;
}

function deployDesk(snap: Snapshot | null): Desk {
  const d: Desk = { id: "repartidor", room: "muelle", name: "El repartidor", mood: "idle", status: "Sin entregas", details: [] };
  const dep = snap?.deploys;
  if (!dep || isError(dep)) return { ...d, mood: "away", status: "Sin datos del runner" };
  if (dep.bentonime_release) d.details.push(["Versión de Bentonime", dep.bentonime_release.slice(0, 7)]);
  if (dep.bentonime_deployed_at) d.details.push(["Desplegada", ago(dep.bentonime_deployed_at)]);
  if (dep.runner_busy) {
    d.mood = "working";
    d.status = "Entregando una versión nueva…";
  } else if (dep.bentonime_deployed_at) {
    d.status = `Última entrega: ${ago(dep.bentonime_deployed_at)}`;
  }
  return d;
}

async function guardDesk(ctx: Ctx, snap: Snapshot | null, inbox: InboxItem[]): Promise<Desk> {
  const d: Desk = { id: "guardia", room: "recepcion", name: "El guardia", mood: "idle", status: "Todo tranquilo", details: [] };
  const wd = await watchdogStatus();
  const checks = (isError(wd) ? [] : Array.isArray(wd) ? wd : ((wd as { checks?: unknown[] }).checks ?? [])) as Array<{
    label: string;
    alerting: boolean;
    minutesSilent: number | null;
  }>;
  if (isError(wd)) d.details.push(["Vigilante externo", `sin respuesta: ${wd.error}`]);
  for (const c of checks) {
    d.details.push([c.label, c.alerting ? "¡en alerta!" : c.minutesSilent == null ? "sin señales aún" : `señal hace ${c.minutesSilent} min`]);
    if (c.alerting) {
      d.mood = "error";
      d.status = `${c.label}: sin señal`;
      inbox.push({ from: d.name, level: "error", text: `Vigilante: ${c.label} en alerta` });
    }
  }
  const f2b = snap && !isError(snap.services) ? (snap.services as Record<string, UnitState>).fail2ban : undefined;
  if (f2b) d.details.push(["fail2ban", f2b.ActiveState ?? "?"]);
  const s = ctx.attacks.summary(24);
  const attempts = Object.values(s.intentos_por_tipo).reduce((a, b) => a + b, 0);
  d.details.push(["Intentos de ataque (24 h)", String(attempts)], ["IPs atacando (24 h)", String(s.ips_distintas)]);
  // "Hoy" = desde medianoche en Madrid, la misma cuenta que la pizarra del día.
  const today = ctx.attacks.attemptsSince(madridMidnight());
  if (d.mood === "idle" && today > 0) d.status = `${today} intentos de colarse hoy, ninguno ha pasado`;
  return d;
}

function secretaryDesk(ctx: Ctx, snap: Snapshot | null, inbox: InboxItem[]): Desk {
  const d: Desk = { id: "secretario", room: "secretaria", name: "El secretario (bot)", mood: "idle", status: "Nada pendiente", details: [] };
  // Los logs nuevos no van a la bandeja: Alex no quiere avisos de eso.
  const { items } = ctx.expiries.list(snap);
  const soon = items.filter((i) => i.days_left <= 30);
  d.details.push(["Caduca en 30 días", String(soon.length)]);
  for (const i of soon) {
    inbox.push({ from: d.name, level: i.days_left <= 7 ? "error" : "warn", text: `${i.what}: ${i.days_left < 0 ? "caducado" : `${i.days_left} días`} (${i.day})` });
  }
  if (soon.length) {
    d.mood = "needs_you";
    d.status = `${soon.length} caducidad${soon.length === 1 ? "" : "es"}`;
  }
  return d;
}

export async function officeState(ctx: Ctx): Promise<OfficeState> {
  const raw = await readSnapshot();
  const snap = isError(raw) ? null : raw;
  const inbox: InboxItem[] = [];
  if (!snap) inbox.push({ from: "Oficina", level: "error", text: isError(raw) ? raw.error : "sin snapshot" });

  const cinema = { viewers: [] as Array<{ key: string; name: string }> };
  const desks = [
    backupsDesk(snap, inbox),
    await bentonimeDesk(snap, inbox, cinema),
    deployDesk(snap),
    await guardDesk(ctx, snap, inbox),
    secretaryDesk(ctx, snap, inbox),
  ];

  const server: Array<[string, string]> = [];
  const s = snap?.system;
  if (s && !s.error) {
    const used = (s.mem_total ?? 0) - (s.mem_available ?? 0);
    server.push(["RAM", `${bytes(used)} / ${bytes(s.mem_total)}`]);
    const root = s.disks?.["/"];
    if (root) server.push(["Disco", `${bytes(root.used)} / ${bytes(root.total)}`]);
    if (s.load) server.push(["Carga", s.load.join(" · ")]);
  }
  const smart = snap?.smart as { temperature_c?: number; passed?: boolean } | undefined;
  if (smart?.temperature_c != null) server.push(["SSD", `${smart.temperature_c} °C · ${smart.passed ? "sano" : "¡revisar!"}`]);

  // Racks: TODOS los servidores del panel (todos los nodos). El estado en
  // directo solo se conoce de los nodos cuyo Wings se puede consultar (de
  // momento, este); el resto sale como "sin datos". Encendidos primero.
  const live = new Map(wingsServers(snap).map((w) => [w.uuid, w]));
  const inv = ctx.ptero.inv && !isError(ctx.ptero.inv) ? ctx.ptero.inv : null;
  const ORDER: Record<string, number> = { running: 0, starting: 1, stopping: 2 };
  const racks: OfficeState["racks"] = inv
    ? inv.servers
        .map((s) => {
          const w = live.get(s.uuid);
          const node = inv.nodes.find((n) => n.id === s.node);
          return {
            name: s.name,
            owner: s.owner,
            node: node?.name ?? String(s.node),
            state: s.suspended ? "suspended" : (w?.state ?? (ctx.ptero.reach.get(s.node) === false ? "node_down" : "unknown")),
            mem: w?.mem_bytes ?? null,
            limit: s.memoryMb ? s.memoryMb * 1024 ** 2 : null,
            cpu: w?.cpu_pct ?? 0,
          };
        })
        .sort((a, b) => (ORDER[a.state] ?? (a.state === "offline" ? 4 : 3)) - (ORDER[b.state] ?? (b.state === "offline" ? 4 : 3)) || a.name.localeCompare(b.name))
    : snap && !isError(snap.containers)
      ? snap.containers
          .filter((c) => c.server)
          .map((c) => ({ name: c.server ?? c.container, owner: null, node: null, state: "running", mem: c.mem_bytes, limit: c.mem_limit_bytes, cpu: c.cpu_pct }))
      : [];
  const localUuids = new Set(localWingsServers(snap).map((w) => w.uuid));
  const here = inv?.nodes.find((n) => inv.servers.some((s) => s.node === n.id && localUuids.has(s.uuid)));
  const nodes = (inv?.nodes ?? []).map((n) => ({
    name: n.name,
    local: n === here,
    reachable: ctx.ptero.reach.get(n.id) ?? null,
    servers: inv?.servers.filter((s) => s.node === n.id).length ?? 0,
    live: inv?.servers.some((s) => s.node === n.id && live.has(s.uuid)) ?? false,
  }));

  const f2b = snap?.fail2ban && !isError(snap.fail2ban) ? snap.fail2ban : {};
  const banned = [...new Set(Object.values(f2b).flatMap((j) => j.banned))];
  const services = snap && !isError(snap.services) ? (snap.services as Record<string, UnitState>) : {};
  const down = Object.entries(services)
    .filter(([unit, st]) => !unit.endsWith(".timer") && st.ActiveState && st.ActiveState !== "active")
    .map(([unit]) => unit);
  const proj = desks.find((d) => d.id === "proyeccionista");
  const detail = (k: string) => Number(proj?.details.find(([x]) => x === k)?.[1] ?? 0) || 0;
  const { items } = ctx.expiries.list(snap);
  const midnight = madridMidnight();

  return {
    at: new Date().toISOString(),
    server,
    desks,
    racks,
    inbox,
    claude: ctx.claude.list(),
    scene: {
      banned: { count: banned.length, recent: banned.slice(-6).reverse() },
      backupsToday: ctx.events.count("backup.ok", midnight),
      down,
      downloading: detail("Descargando"),
      queued: detail("En cola"),
      urgentExpiries: items.filter((i) => i.days_left <= 7).length,
      node: here
        ? {
            name: here.name,
            promisedGb: Math.round(here.allocatedMemoryMb / 1024),
            physicalGb: snap?.system.mem_total ? Math.round(snap.system.mem_total / 1024 ** 3) : null,
            freePorts: here.freePorts.length,
          }
        : null,
      nodes,
      weather: ctx.weather.now(),
      watching: detail("Viendo ahora"),
      viewers: cinema.viewers,
      pulse: {
        load1: Math.round((loadavg()[0] ?? 0) * 100) / 100,
        cpus: cpus().length || (s?.cpus ?? 1),
        ssdTempC: typeof smart?.temperature_c === "number" ? smart.temperature_c : null,
      },
      today: {
        attacks: ctx.attacks.attemptsSince(midnight),
        bans: ctx.events.count("ban", midnight),
        backups: ctx.events.count("backup.ok", midnight),
        deploys: ctx.events.count("deploy.done", midnight),
        claudeMinutes: Math.round(ctx.claude.workedSince(midnight) / 60_000),
      },
      music: ctx.spotify.now(),
      lockDays: items.filter((i) => i.kind === "certificado").reduce<number | null>((m, i) => (m == null || i.days_left < m ? i.days_left : m), null),
      works: readWorks(config.worksDir),
    },
  };
}
