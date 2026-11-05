/**
 * Asistente de operaciones: bot de Discord con un modelo de Groq.
 *  - Cada 15 s mira systemd y Bentonime y genera eventos para la oficina
 *    ("empieza el backup", "episodio listo"…).
 *  - Cada 5 min guarda las métricas del recolector en su histórico y revisa
 *    los logs: avisa por DM de patrones nuevos o que se disparan.
 *  - Cada día a ASSISTANT_SUMMARY_HOUR (Madrid) manda el resumen por DM y
 *    avisa de lo que caduca pronto.
 *  - Responde a los DMs del owner con sus herramientas.
 */
import { dailySummary } from "./agent";
import { broadcast, startApi } from "./api";
import { loadGeoIp } from "./attacks";
import { config } from "./config";
import { openContext } from "./context";
import { bentonimeSummary, isError, readSnapshot, type Snapshot } from "./data";
import { startDiscord } from "./discord";
import { diffLive, diffSnap, type Live, runnerBusy, type SnapFacts, unitStates } from "./events";
import { readLogBatches } from "./logs";
import { localWingsServers } from "./ptero";
import { daily } from "./schedule";

const ctx = openContext();
// Todo evento nuevo sale a las oficinas abiertas al momento.
ctx.events.onEvent((e) => broadcast("event", e));

let lastSnapFacts: SnapFacts | null = null;
function snapFacts(snap: Snapshot): SnapFacts {
  const deploys = snap.deploys && !isError(snap.deploys) ? snap.deploys : undefined;
  const f2b = snap.fail2ban && !isError(snap.fail2ban) ? snap.fail2ban : {};
  return {
    release: deploys?.bentonime_release ?? null,
    lastDeploy: deploys?.last_deploy ?? null,
    certs: snap.certificates && !isError(snap.certificates)
      ? Object.fromEntries(Object.entries(snap.certificates).flatMap(([n, c]) => (c.expires_at ? [[n, c.expires_at]] : [])))
      : {},
    banned: [...new Set(Object.values(f2b).flatMap((j) => j.banned))],
  };
}

async function sample() {
  const snap = await readSnapshot();
  if (isError(snap)) {
    console.warn("muestra omitida:", snap.error);
    return;
  }
  ctx.history.record(snap);
  const facts = snapFacts(snap);
  for (const e of diffSnap(lastSnapFacts, facts, (ip) => ctx.attacks.geo?.lookup(ip).country ?? null)) ctx.events.push(e);
  lastSnapFacts = facts;
  // Pterodactyl: inventario del panel y arranques/paradas de este nodo.
  const local = new Set(localWingsServers(snap).map((w) => w.uuid));
  for (const e of await ctx.ptero.refresh(local)) ctx.events.push(e);
  for (const e of ctx.ptero.stateChanges(snap)) ctx.events.push(e);
}

/** Reincidente, como en el panel: la IP ya venía de antes de las últimas 24 h. */
function isReturning(ip: string, ts: number): boolean {
  const first = ctx.attacks.firstSeen(ip);
  return first != null && first < ts - 24 * 3600_000;
}

let lastLive: Live | null = null;
async function watchLive() {
  const [units, busy, bento] = await Promise.all([unitStates(), runnerBusy(), bentonimeSummary(24)]);
  const sum = isError(bento)
    ? null
    : (bento as {
        newEpisodes?: Array<{ anime: string; slug: string; number: number; downloaded: boolean }>;
        downloads?: { byStatus?: Record<string, number>; recentFailures?: Array<{ anime: string; number: number; at: string }> };
        watchers?: Array<{ key: string; name: string }>;
        rejectedLogins?: Array<{ name: string; at: string }>;
      });
  const live: Live = {
    units,
    runnerBusy: busy,
    downloads: sum
      ? {
          running: sum.downloads?.byStatus?.running ?? 0,
          queued: sum.downloads?.byStatus?.queued ?? 0,
          episodes: sum.newEpisodes ?? [],
          failures: sum.downloads?.recentFailures ?? [],
        }
      : null,
    viewers: sum?.watchers ?? null,
    rejections: sum?.rejectedLogins ?? null,
  };
  // Si Bentonime no contesta una vez, no se inventan descargas (ni espectadores) al volver.
  if (!live.downloads && lastLive) live.downloads = lastLive.downloads;
  if (!live.viewers && lastLive) live.viewers = lastLive.viewers;
  if (!live.rejections && lastLive) live.rejections = lastLive.rejections;
  for (const e of diffLive(lastLive, live)) ctx.events.push(e);
  lastLive = live;
}

async function watchLogs() {
  // Sin Discord todavía, los lotes esperan: así no se marca nada como visto sin avisar.
  if (!discord.ready()) return;
  const batches = await readLogBatches();
  if (isError(batches)) {
    console.warn("logs omitidos:", batches.error);
    return;
  }
  const feedBefore = ctx.attacks.summary(1).feed[0]?.ts ?? 0;
  const downloads = ctx.attacks.ingest(batches);
  const newFeed = ctx.attacks.summary(1).feed.filter((f) => f.ts > feedBefore);
  if (newFeed.length) {
    broadcast("attack", newFeed);
    const attempts = newFeed.reduce((a, f) => a + f.count, 0);
    const countries = [...new Set(newFeed.map((f) => f.country).filter(Boolean))] as string[];
    ctx.events.push({
      type: "attack",
      level: "info",
      text: `${attempts} intento${attempts === 1 ? "" : "s"} de colarse${countries.length ? ` desde ${countries.slice(0, 4).join(", ")}` : ""}`,
      data: { attempts, countries, kinds: [...new Set(newFeed.map((f) => f.kind))], visitors: newFeed.slice(0, 4).map((f) => ({ country: f.country, kind: f.kind, text: f.text.slice(0, 60), returning: isReturning(f.ip, f.ts) })) },
    });
  }
  // Lo del honeypot sale en la oficina y en el panel, sin DM.
  for (const d of downloads) {
    const what = d.url.startsWith("subido: ") ? `un archivo subido (${d.url.slice(8)})` : "una descarga";
    ctx.events.push({ type: "malware", level: "warn", text: `El honeypot caza ${what} desde ${d.ip}${d.country ? ` (${d.country})` : ""}`, data: { country: d.country } });
  }

  // Anomalías en logs: se aprenden en silencio (para la herramienta `logs`).
  // Alex solo quiere avisos cuando alguien entra de verdad (eso lo hace PAM:
  // server-scripts/login-alert), no de cada línea rara.
  const anomalies = ctx.logs.ingest(batches);
  if (anomalies.length) console.log(`logs: ${anomalies.length} anomalías (sin aviso)`);
}

/** País y red de las IPs atacantes: la base se renueva cada semana. */
async function refreshGeo() {
  const geo = await loadGeoIp();
  if (!geo) return;
  ctx.attacks.geo = geo;
  const n = ctx.attacks.backfillGeo();
  console.log(`ip2asn: ${geo.size} rangos${n ? `, ${n} IPs completadas` : ""}`);
}

async function checkExpiries() {
  await ctx.expiries.refreshDomains();
  const snap = await readSnapshot();
  const { items } = ctx.expiries.list(isError(snap) ? null : snap);
  const due = ctx.expiries.due(items);
  for (const i of due) {
    ctx.events.push({ type: "expiry", level: i.days_left <= 7 ? "error" : "warn", text: `${i.what}: ${i.days_left < 0 ? "caducado" : `caduca en ${i.days_left} días`}` });
  }
  if (due.length > 0) await discord.sendExpiries(due);
}

const discord = startDiscord(ctx);

await sample();
setInterval(() => sample().catch((err) => console.error("muestra fallida", err)), 5 * 60_000);
setInterval(() => watchLogs().catch((err) => console.error("revisión de logs fallida", err)), 60_000);
await watchLive().catch((err) => console.error("eventos en vivo fallidos", err));
setInterval(() => watchLive().catch((err) => console.error("eventos en vivo fallidos", err)), 15_000);
// Al arrancar, solo refresca los dominios (para el resumen); los avisos, a la hora del resumen.
ctx.expiries.refreshDomains().catch((err) => console.error("RDAP fallido", err));
refreshGeo().catch((err) => console.error("ip2asn fallido", err));
setInterval(() => refreshGeo().catch((err) => console.error("ip2asn fallido", err)), 24 * 3600_000);
// El tiempo para las ventanas de la oficina.
ctx.weather.refresh().catch((err) => console.error("tiempo fallido", err));
setInterval(() => ctx.weather.refresh().catch((err) => console.error("tiempo fallido", err)), 15 * 60_000);
// Lo que suena en Spotify (si está configurado), para el tocadiscos.
if (ctx.spotify.enabled) {
  const music = () => ctx.spotify.refresh().catch((err) => console.error("Spotify fallido", (err as Error).message));
  music();
  setInterval(music, 15_000);
}

startApi(ctx);

daily(config.summaryHour, async () => {
  const text = await dailySummary(ctx);
  await discord.sendSummary(text);
  ctx.events.push({ type: "bot.summary", level: "info", text: "El secretario te manda el resumen de la mañana" });
  console.log("resumen diario enviado");
  await checkExpiries().catch((err) => console.error("aviso de caducidades fallido", err));
});

console.log(
  `asistente en marcha (modelo ${config.model}, resumen a las ${config.summaryHour}:00, API de la oficina en 127.0.0.1:${config.apiPort})`,
);
