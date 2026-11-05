import {
  bentonimeSummary,
  type ContainerStat,
  isError,
  readSnapshot,
  type Snapshot,
  watchdogStatus,
} from "./data";
import type { Ctx } from "./context";
import { bytes, duration, madrid } from "./format";
import type { History } from "./history";

/**
 * Vistas legibles de cada fuente: lo que reciben las herramientas del modelo
 * y el resumen diario. Tamaños humanos y horas de Madrid para que el modelo
 * no tenga que convertir nada.
 */

function pct(used: number, total: number): string {
  return `${Math.round((used / total) * 100)} %`;
}

export function systemView(snap: Snapshot) {
  const s = snap.system;
  const memUsed = (s.mem_total ?? 0) - (s.mem_available ?? 0);
  return {
    actualizado: madrid(snap.collected_at),
    equipo: s.hostname,
    encendido_desde_hace: s.uptime_s != null ? duration(s.uptime_s) : null,
    carga_1_5_15min: s.load,
    cpus: s.cpus,
    ram: s.mem_total ? `${bytes(memUsed)} de ${bytes(s.mem_total)} (${pct(memUsed, s.mem_total)})` : null,
    swap_usada: bytes(s.swap_used),
    discos: Object.fromEntries(
      Object.entries(s.disks ?? {}).map(([path, d]) => [
        path,
        `${bytes(d.used)} de ${bytes(d.total)} (${pct(d.used, d.total)}), libres ${bytes(d.free)}`,
      ]),
    ),
    smart: snap.smart,
    servicios: isError(snap.services)
      ? snap.services
      : Object.fromEntries(
          Object.entries(snap.services).map(([unit, st]) => [
            unit,
            [st.ActiveState, st.SubState, Number(st.NRestarts) > 0 ? `${st.NRestarts} reinicios` : null]
              .filter(Boolean)
              .join(" / "),
          ]),
        ),
  };
}

function ts(v: string | number | undefined): string | null {
  return typeof v === "number" && v > 0 ? madrid(v * 1000) : null;
}

export function backupsView(snap: Snapshot) {
  if (isError(snap.backups)) return snap.backups;
  return Object.fromEntries(
    Object.entries(snap.backups).map(([mode, st]) => {
      const start = typeof st.ExecMainStartTimestamp === "number" ? st.ExecMainStartTimestamp : 0;
      const end = typeof st.ExecMainExitTimestamp === "number" ? st.ExecMainExitTimestamp : 0;
      return [
        mode,
        start === 0
          ? "sin ejecuciones desde el último arranque del servidor"
          : {
              estado: st.ActiveState === "activating" ? "en marcha ahora" : st.Result,
              codigo_salida: st.ExecMainStatus,
              ultimo_inicio: ts(start),
              ultimo_fin: ts(end),
              duracion: end > start ? duration(end - start) : null,
            },
      ];
    }),
  );
}

export function containersView(snap: Snapshot, history: History, hours: number) {
  if (isError(snap.containers)) return snap.containers;
  const peaks = new Map(
    history.peaks(Date.now() - hours * 3600_000).map((p) => [p.container, p]),
  );
  const label = (c: Pick<ContainerStat, "server" | "container">) =>
    c.server ?? `${c.container} (no es un servidor del panel)`;
  return {
    nota: "Métricas tomadas desde el host. Son servidores de clientes: nunca actuar dentro de ellos.",
    ventana_horas: hours,
    contenedores: snap.containers
      .map((c) => {
        const p = peaks.get(c.container);
        return {
          servidor: label(c),
          ram_ahora: bytes(c.mem_bytes),
          limite: c.mem_limit_bytes ? bytes(c.mem_limit_bytes) : null,
          cpu_ahora: `${c.cpu_pct.toFixed(1)} %`,
          ram_pico: p ? `${bytes(p.peak_mem_bytes)} (${madrid(p.peak_at)})` : "sin histórico aún",
          cpu_media: p ? `${p.avg_cpu_pct.toFixed(1)} %` : null,
          _orden: c.mem_bytes ?? 0,
        };
      })
      .sort((a, b) => b._orden - a._orden)
      .map(({ _orden, ...rest }) => rest),
  };
}

/** Un simulacro de más de 35 días cuenta como pendiente (se hace cada mes). */
const SIMULACRO_STALE_DAYS = 35;

export function simulacroView(snap: Snapshot, now = Date.now()) {
  const s = snap.simulacro;
  if (!s) return { error: "el recolector aún no informa del simulacro" };
  if (isError(s)) return s;
  const days = Math.floor((now - Date.parse(s.at)) / 86_400_000);
  return {
    resultado: s.ok ? "superado" : `FALLIDO en el paso: ${s.step ?? "?"}`,
    cuando: madrid(s.at),
    hace_dias: days,
    atrasado: days > SIMULACRO_STALE_DAYS,
    duracion: s.duration_s != null ? duration(s.duration_s) : null,
    comprobaciones: s.checks,
  };
}

export function logsView(ctx: Pick<Ctx, "logs">, hours: number) {
  const r = ctx.logs.recent(Date.now() - hours * 3600_000);
  return {
    nota: "Huellas = mensajes de log agrupados sin números, IDs ni IPs. 'nuevos' son los que nunca se habían visto.",
    ventana_horas: hours,
    nuevos: r.nuevos.map((p) => ({
      huella: p.fp,
      servicio: p.unit,
      ejemplo: p.sample,
      desde: madrid(p.first_seen),
      veces: p.total,
      silenciado: p.muted === 1,
    })),
    mas_frecuentes: r.top.filter((p) => p.muted === 0).map((p) => ({ huella: p.fp, servicio: p.unit, ejemplo: p.sample, veces: p.veces })),
    bloqueos_cortafuegos: r.bloqueos_ufw,
    silenciados: r.silenciados.map((p) => ({ huella: p.fp, servicio: p.unit, ejemplo: p.sample })),
  };
}

export function expiriesView(ctx: Pick<Ctx, "expiries">, snap: Snapshot | null, withinDays?: number) {
  const { items, errors } = ctx.expiries.list(snap);
  return {
    caducidades: items
      .filter((i) => withinDays == null || i.days_left <= withinDays)
      .map((i) => ({
        que: i.what,
        tipo: i.kind,
        fecha: i.day,
        dias: i.days_left,
        ...(i.notes ? { notas: i.notes } : {}),
        ...(i.id != null ? { id_recordatorio: i.id } : {}),
      })),
    ...(errors.length ? { errores: errors } : {}),
  };
}

/** Todo junto, para el resumen diario (una sola llamada al modelo, sin herramientas). */
export async function fullReport(ctx: Ctx) {
  const [snap, bento, watchdog] = await Promise.all([
    readSnapshot(),
    bentonimeSummary(24),
    watchdogStatus(),
  ]);
  return {
    servidor: isError(snap) ? snap : systemView(snap),
    backups: isError(snap) ? snap : backupsView(snap),
    simulacro_restauracion: isError(snap) ? snap : simulacroView(snap),
    clientes_pterodactyl: isError(snap) ? snap : containersView(snap, ctx.history, 24),
    bentonime_ultimas_24h: bento,
    vigilante_externo: watchdog,
    ataques_ultimas_24h: (() => {
      const a = ctx.attacks.summary(24);
      return {
        intentos_por_tipo: a.intentos_por_tipo,
        ips_distintas: a.ips_distintas,
        paises: a.paises.slice(0, 3),
        descargas_honeypot: a.descargas.filter((d) => d.first_seen >= Date.now() - 86_400_000).length,
      };
    })(),
    caducidades_proximos_30_dias: expiriesView(ctx, isError(snap) ? null : snap, 30),
  };
}
