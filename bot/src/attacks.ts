import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import type { LogBatch } from "./logs";

/**
 * Quién ataca lo que está abierto a internet: SFTP de Wings, sondas web a
 * nginx y el honeypot (Cowrie, SSH y Telnet falsos). El recolector agrupa por
 * (tipo, IP) en cada lote; aquí se acumula, se le pone país y red (base libre
 * ip2asn de iptoasn.com, se baja cada semana) y se sirve a la oficina.
 */

export type AttackKind = "sftp" | "web" | "ssh" | "telnet";

export interface AttackRecord {
  kind: AttackKind;
  ip: string;
  /** Intentos: logins (sftp, ssh, telnet) o peticiones (web). */
  count: number;
  users?: Record<string, number>;
  /** "usuario:contraseña" → veces (solo el honeypot). */
  creds?: Record<string, number>;
  paths?: Record<string, number>;
  status?: Record<string, number>;
  commands?: string[];
  downloads?: Array<{ url: string; sha256?: string | null }>;
  sessions?: number;
  logins_ok?: number;
  client?: string;
  agent?: string;
  /** Hora real (ms) del último evento de la IP en el lote; si falta, la del lote. */
  ts?: number;
}

export interface Geo {
  country: string | null;
  asn: number | null;
  asName: string | null;
}

const IP2ASN_URL = "https://iptoasn.com/data/ip2asn-v4.tsv.gz";
const IP2ASN_EVERY_MS = 7 * 86_400_000;
const HOUR = 3600_000;
const FEED_KEEP = 500;
/** Lo que se guarda por horas para las tablas con ventana (la más larga es 30 días). */
const STAT_KEEP_HOURS = 31 * 24;

/**
 * Cowrie escribe los bytes nulos de Telnet como texto ("enable\x00"); se quitan.
 * En los comandos además se juntan espacios, para que "ping ;sh" y "ping; sh"
 * cuenten como uno.
 */
export function cleanText(s: string): string {
  return s.replace(/\\x00|\u0000/g, "");
}

export function cleanCommand(s: string): string {
  return cleanText(s).replace(/\s+/g, " ").replace(/ ?; ?/g, "; ").trim();
}

/** "usuario:contraseña" (la contraseña puede llevar ":"), ya limpios. */
function splitCred(raw: string): { user: string; password: string } {
  const i = raw.indexOf(":");
  return { user: cleanText(i < 0 ? raw : raw.slice(0, i)), password: cleanText(i < 0 ? "" : raw.slice(i + 1)) };
}

/** Hora del evento si es creíble (no futura ni de hace más de una semana); si no, la del lote. */
function eventTs(a: AttackRecord, batchTs: number): number {
  return a.ts && a.ts <= batchTs + 60_000 && a.ts > batchTs - 7 * 24 * HOUR ? a.ts : batchTs;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** Rangos IPv4 → país y red. En memoria (~10 MB); búsqueda binaria. */
export class GeoIp {
  private starts = new Uint32Array(0);
  private ends = new Uint32Array(0);
  private asns = new Uint32Array(0);
  private countries: string[] = [];
  private names = new Map<number, string>();

  static fromTsv(tsv: string): GeoIp {
    const g = new GeoIp();
    const lines = tsv.split("\n");
    const starts: number[] = [];
    const ends: number[] = [];
    const asns: number[] = [];
    for (const line of lines) {
      const [s, e, asn, country, name] = line.split("\t");
      const a = s ? ipv4ToInt(s) : null;
      const b = e ? ipv4ToInt(e) : null;
      if (a == null || b == null) continue;
      const num = Number(asn);
      if (num === 0) continue; // "Not routed"
      starts.push(a);
      ends.push(b);
      asns.push(num);
      g.countries.push(country === "None" ? "" : (country ?? ""));
      if (name && !g.names.has(num)) g.names.set(num, name.trim());
    }
    g.starts = Uint32Array.from(starts);
    g.ends = Uint32Array.from(ends);
    g.asns = Uint32Array.from(asns);
    return g;
  }

  get size(): number {
    return this.starts.length;
  }

  lookup(ip: string): Geo {
    const n = ipv4ToInt(ip);
    if (n == null) return { country: null, asn: null, asName: null };
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.starts[mid] ?? 0) > n) hi = mid - 1;
      else if ((this.ends[mid] ?? 0) < n) lo = mid + 1;
      else {
        const asn = this.asns[mid] ?? 0;
        return { country: this.countries[mid] || null, asn, asName: this.names.get(asn) ?? null };
      }
    }
    return { country: null, asn: null, asName: null };
  }
}

/** Baja la base si falta o tiene más de una semana; la carga. Sin red, la que haya. */
export async function loadGeoIp(dir = config.dataDir): Promise<GeoIp | null> {
  const path = join(dir, "ip2asn-v4.tsv.gz");
  const fresh = existsSync(path) && Date.now() - statSync(path).mtimeMs < IP2ASN_EVERY_MS;
  if (!fresh) {
    try {
      const res = await fetch(IP2ASN_URL, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`iptoasn respondió ${res.status}`);
      await Bun.write(path, await res.arrayBuffer());
    } catch (err) {
      console.warn("no se pudo bajar ip2asn:", (err as Error).message);
    }
  }
  if (!existsSync(path)) return null;
  const tsv = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await Bun.file(path).arrayBuffer())));
  return GeoIp.fromTsv(tsv);
}

export interface Notable {
  kind: "descarga";
  ip: string;
  country: string | null;
  url: string;
  sha256: string | null;
}

/** Una línea legible de lo que hizo un atacante en un lote (para el feed de la oficina). */
export function describeAttack(a: AttackRecord): string {
  const top = (d?: Record<string, number>, n = 3) =>
    Object.entries(d ?? {})
      .sort((x, y) => y[1] - x[1])
      .slice(0, n)
      .map(([k]) => k);
  const file = a.downloads?.[0]?.url;
  if (file?.startsWith("subido: ")) return `subió el archivo ${file.slice(8)}`;
  if (file) return `intentó descargar ${file}`;
  if (a.commands?.length) return `ejecutó: ${a.commands.slice(0, 2).join(" ; ")}`;
  if (a.kind === "web") return `pidió ${top(a.paths, 2).join(", ")}`;
  const creds = top(a.creds, 3);
  if (creds.length) return `probó ${creds.join(", ")}`;
  const users = top(a.users, 3);
  if (users.length) return `probó el usuario ${users.join(", ")}`;
  return a.sessions ? "se conectó" : `${a.count} intentos`;
}

/**
 * Cómo son las contraseñas que prueban (ponderado por veces): longitud y tipo
 * de caracteres. Al estilo de los informes de DShield/HoneyWatch.
 */
export function passwordStats(rows: Array<{ password: string; n: number }>) {
  const longitud: Record<string, number> = {};
  const tipo: Record<string, number> = { vacia: 0, solo_numeros: 0, solo_letras: 0, letras_y_numeros: 0, con_simbolos: 0 };
  let total = 0;
  for (const { password: p, n } of rows) {
    total += n;
    const len = [...p].length;
    const bucket = len >= 16 ? "16+" : String(len);
    longitud[bucket] = (longitud[bucket] ?? 0) + n;
    const kind = !p
      ? "vacia"
      : /^\d+$/.test(p)
        ? "solo_numeros"
        : /^\p{L}+$/u.test(p)
          ? "solo_letras"
          : /^[\p{L}\d]+$/u.test(p)
            ? "letras_y_numeros"
            : "con_simbolos";
    tipo[kind] = (tipo[kind] ?? 0) + n;
  }
  return { total, longitud, tipo };
}

export class Attacks {
  geo: GeoIp | null = null;

  constructor(readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attack_ip (
        ip TEXT NOT NULL,
        kind TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        sessions INTEGER NOT NULL DEFAULT 0,
        logins_ok INTEGER NOT NULL DEFAULT 0,
        country TEXT,
        asn INTEGER,
        as_name TEXT,
        client TEXT,
        PRIMARY KEY (ip, kind)
      );
      CREATE TABLE IF NOT EXISTS attack_hourly (
        kind TEXT NOT NULL,
        hour INTEGER NOT NULL,
        n INTEGER NOT NULL,
        PRIMARY KEY (kind, hour)
      );
      CREATE TABLE IF NOT EXISTS attack_user (
        kind TEXT NOT NULL,
        username TEXT NOT NULL,
        n INTEGER NOT NULL,
        PRIMARY KEY (kind, username)
      );
      CREATE TABLE IF NOT EXISTS attack_cred (
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        n INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (username, password)
      );
      CREATE TABLE IF NOT EXISTS attack_cmd (
        cmd TEXT PRIMARY KEY,
        n INTEGER NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        ip TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attack_download (
        sha256 TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        ip TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        n INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attack_path (
        path TEXT PRIMARY KEY,
        n INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attack_feed (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        ip TEXT NOT NULL,
        country TEXT,
        count INTEGER NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attack_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Usuarios, credenciales, comandos y rutas por hora, para las ventanas de
      -- 24 h / 7 / 30 días (las tablas de arriba son el histórico sin fecha).
      CREATE TABLE IF NOT EXISTS attack_stat (
        stat TEXT NOT NULL,
        kind TEXT NOT NULL,
        k1 TEXT NOT NULL,
        k2 TEXT NOT NULL DEFAULT '',
        hour INTEGER NOT NULL,
        n INTEGER NOT NULL,
        PRIMARY KEY (stat, kind, k1, k2, hour)
      );
      CREATE INDEX IF NOT EXISTS attack_stat_hour ON attack_stat (stat, hour);
    `);
  }

  /**
   * Acumula los lotes nuevos. Devuelve lo que merece un DM: descargas de
   * archivos (malware) nunca vistas. El lote semilla (7 días de golpe) entra
   * en los totales pero no en la línea de tiempo ni en el feed.
   */
  ingest(batches: LogBatch[]): Notable[] {
    const lastRow = this.db.query("SELECT value FROM attack_meta WHERE key = 'last_batch'").get() as {
      value: string;
    } | null;
    const last = Number(lastRow?.value ?? 0);
    const fresh = batches.filter((b) => b.id > last).sort((a, b) => a.id - b.id);
    const notable: Notable[] = [];
    if (fresh.length === 0) return notable;

    const upsertIp = this.db.prepare(`
      INSERT INTO attack_ip (ip, kind, first_seen, last_seen, attempts, sessions, logins_ok, country, asn, as_name, client)
      VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT (ip, kind) DO UPDATE SET
        last_seen = ?3, attempts = attempts + ?4, sessions = sessions + ?5, logins_ok = logins_ok + ?6,
        country = COALESCE(?7, country), asn = COALESCE(?8, asn), as_name = COALESCE(?9, as_name),
        client = COALESCE(client, ?10)`);
    const hourly = this.db.prepare(
      "INSERT INTO attack_hourly (kind, hour, n) VALUES (?1, ?2, ?3) ON CONFLICT (kind, hour) DO UPDATE SET n = n + ?3",
    );
    const user = this.db.prepare(
      "INSERT INTO attack_user (kind, username, n) VALUES (?1, ?2, ?3) ON CONFLICT (kind, username) DO UPDATE SET n = n + ?3",
    );
    const cred = this.db.prepare(
      `INSERT INTO attack_cred (username, password, n, last_seen) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (username, password) DO UPDATE SET n = n + ?3, last_seen = ?4`,
    );
    const cmd = this.db.prepare(
      `INSERT INTO attack_cmd (cmd, n, first_seen, last_seen, ip) VALUES (?1, 1, ?2, ?2, ?3)
       ON CONFLICT (cmd) DO UPDATE SET n = n + 1, last_seen = ?2`,
    );
    const dlSeen = this.db.prepare("SELECT 1 FROM attack_download WHERE sha256 = ?");
    const dl = this.db.prepare(
      `INSERT INTO attack_download (sha256, url, ip, first_seen, n) VALUES (?1, ?2, ?3, ?4, 1)
       ON CONFLICT (sha256) DO UPDATE SET n = n + 1`,
    );
    const path = this.db.prepare(
      `INSERT INTO attack_path (path, n, last_seen) VALUES (?1, ?2, ?3)
       ON CONFLICT (path) DO UPDATE SET n = n + ?2, last_seen = ?3`,
    );
    const feed = this.db.prepare(
      "INSERT INTO attack_feed (ts, kind, ip, country, count, text) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const stat = this.db.prepare(
      `INSERT INTO attack_stat (stat, kind, k1, k2, hour, n) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (stat, kind, k1, k2, hour) DO UPDATE SET n = n + ?6`,
    );
    const addStats = (a: AttackRecord, hour: number) => {
      for (const [k, n] of Object.entries(a.users ?? {})) stat.run("user", a.kind, cleanText(k), "", hour, n);
      for (const [k, n] of Object.entries(a.creds ?? {})) {
        const { user: u, password: p } = splitCred(k);
        stat.run("cred", a.kind, u, p, hour, n);
      }
      for (const raw of a.commands ?? []) {
        const c = cleanCommand(raw);
        if (c) stat.run("cmd", a.kind, c, "", hour, 1);
      }
      for (const [k, n] of Object.entries(a.paths ?? {})) stat.run("path", a.kind, k, "", hour, n);
    };

    this.db.transaction(() => {
      // Lo que entró de las IPs propias antes de que el recolector las filtrara.
      for (const ip of new Set(fresh.flatMap((b) => b.own_ips ?? []))) this.forget(ip);
      for (const b of fresh) {
        const batchTs = Date.parse(b.at);
        const records = b.attacks ?? [];
        const anonSftp = b.sftp_failed_other ?? 0;
        if (!b.seed && anonSftp > 0) hourly.run("sftp-anonimo", Math.floor(batchTs / HOUR), anonSftp);
        // Una vez: el recolector rehace desde sus logs las tablas por ventana
        // (hasta lo que ya había leído; lo de después llega en b.attacks).
        const rebuild = b.stats_rebuild;
        if (rebuild) {
          const kinds = rebuild.kinds.map(() => "?").join(", ");
          this.db.run(`DELETE FROM attack_stat WHERE kind IN (${kinds})`, rebuild.kinds);
          const oldest = Date.now() - STAT_KEEP_HOURS * HOUR;
          for (const a of rebuild.attacks) {
            if (a.ts && a.ts >= oldest) addStats(a, Math.floor(a.ts / HOUR));
          }
        }
        for (const a of records) {
          const ts = eventTs(a, batchTs);
          const hour = Math.floor(ts / HOUR);
          // El lote semilla no tiene fecha: entra en el histórico, no en las ventanas.
          if (!b.seed) addStats(a, hour);
          const g = this.geo?.lookup(a.ip) ?? { country: null, asn: null, asName: null };
          upsertIp.run(a.ip, a.kind, ts, a.count, a.sessions ?? 0, a.logins_ok ?? 0, g.country, g.asn, g.asName, a.client ?? null);
          if (!b.seed && a.count > 0) hourly.run(a.kind, hour, a.count);
          for (const [raw, n] of Object.entries(a.users ?? {})) {
            const u = cleanText(raw);
            user.run(a.kind, u, n);
          }
          for (const [raw, n] of Object.entries(a.creds ?? {})) {
            const { user: u, password: p } = splitCred(raw);
            cred.run(u, p, n, ts);
          }
          for (const raw of a.commands ?? []) {
            const c = cleanCommand(raw);
            if (!c) continue;
            cmd.run(c, ts, a.ip);
          }
          for (const d of a.downloads ?? []) {
            const sha = d.sha256 ?? `sin-hash:${d.url}`;
            if (!dlSeen.get(sha) && !b.seed) {
              notable.push({ kind: "descarga", ip: a.ip, country: g.country, url: d.url, sha256: d.sha256 ?? null });
            }
            dl.run(sha, d.url, a.ip, ts);
          }
          for (const [p, n] of Object.entries(a.paths ?? {})) path.run(p, n, ts);
          if (!b.seed) feed.run(ts, a.kind, a.ip, g.country, a.count, describeAttack(a));
        }
        this.db.run(
          "INSERT INTO attack_meta (key, value) VALUES ('last_batch', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1",
          [String(b.id)],
        );
      }
      this.db.run(`DELETE FROM attack_feed WHERE id <= (SELECT MAX(id) FROM attack_feed) - ${FEED_KEEP}`);
      this.db.run("DELETE FROM attack_stat WHERE hour < ?", [Math.floor(Date.now() / HOUR) - STAT_KEEP_HOURS]);
    })();
    return notable;
  }

  /** Borra el rastro por IP (no los totales agregados por hora, usuario o contraseña). */
  forget(ip: string): void {
    for (const table of ["attack_ip", "attack_cmd", "attack_download", "attack_feed"]) {
      this.db.run(`DELETE FROM ${table} WHERE ip = ?`, [ip]);
    }
  }

  /** IPs sin país (llegaron antes de tener la base): se completan al cargarla. */
  backfillGeo(): number {
    if (!this.geo) return 0;
    const rows = this.db.query("SELECT DISTINCT ip FROM attack_ip WHERE asn IS NULL").all() as Array<{ ip: string }>;
    const set = this.db.prepare("UPDATE attack_ip SET country = ?2, asn = ?3, as_name = ?4 WHERE ip = ?1");
    const setFeed = this.db.prepare("UPDATE attack_feed SET country = ?2 WHERE ip = ?1 AND country IS NULL");
    let n = 0;
    this.db.transaction(() => {
      for (const { ip } of rows) {
        const g = this.geo?.lookup(ip);
        if (!g?.asn) continue;
        set.run(ip, g.country, g.asn, g.asName);
        setFeed.run(ip, g.country);
        n++;
      }
    })();
    return n;
  }

  /** Ficha de una IP: por tipo, y lo último que hizo. null si no se ha visto. */
  ipDetail(ip: string) {
    const rows = this.db
      .query(
        `SELECT kind, first_seen, last_seen, attempts, sessions, logins_ok, country, asn, as_name, client
           FROM attack_ip WHERE ip = ? ORDER BY attempts DESC`,
      )
      .all(ip) as Array<{
      kind: AttackKind;
      first_seen: number;
      last_seen: number;
      attempts: number;
      sessions: number;
      logins_ok: number;
      country: string | null;
      asn: number | null;
      as_name: string | null;
      client: string | null;
    }>;
    if (rows.length === 0) return null;
    const feed = this.db
      .query("SELECT ts, kind, count, text FROM attack_feed WHERE ip = ? ORDER BY id DESC LIMIT 20")
      .all(ip) as Array<{ ts: number; kind: AttackKind; count: number; text: string }>;
    const commands = this.db
      .query("SELECT cmd, n, last_seen FROM attack_cmd WHERE ip = ? ORDER BY last_seen DESC LIMIT 20")
      .all(ip) as Array<{ cmd: string; n: number; last_seen: number }>;
    const first = rows[0];
    return {
      ip,
      country: first?.country ?? null,
      asn: first?.asn ?? null,
      as_name: first?.as_name ?? null,
      primera_vez: Math.min(...rows.map((r) => r.first_seen)),
      ultima_vez: Math.max(...rows.map((r) => r.last_seen)),
      intentos: rows.reduce((a, r) => a + r.attempts, 0),
      por_tipo: rows,
      actividad: feed,
      comandos: commands,
    };
  }

  /** Intentos desde `sinceMs` (por horas completas: medianoche de Madrid cae en hora en punto). */
  attemptsSince(sinceMs: number): number {
    return (this.db.query("SELECT COALESCE(SUM(n), 0) AS n FROM attack_hourly WHERE hour >= ?").get(Math.floor(sinceMs / HOUR)) as { n: number }).n;
  }

  /** Primera vez que se vio una IP (cualquier servicio), o null si es nueva. */
  firstSeen(ip: string): number | null {
    return (this.db.query("SELECT MIN(first_seen) AS t FROM attack_ip WHERE ip = ?").get(ip) as { t: number | null }).t;
  }

  /** Todo lo que enseña la sala del honeypot, para una ventana de horas. */
  summary(hours: number, now = Date.now()) {
    const since = now - hours * HOUR;
    const sinceH = Math.floor(since / HOUR);
    const all = <T>(sql: string, ...args: Array<string | number>) => this.db.query(sql).all(...args) as T[];

    const byKind = all<{ kind: string; n: number }>(
      "SELECT kind, SUM(n) AS n FROM attack_hourly WHERE hour >= ? GROUP BY kind",
      sinceH,
    );
    const timeline = all<{ kind: string; hour: number; n: number }>(
      "SELECT kind, hour, n FROM attack_hourly WHERE hour >= ? ORDER BY hour",
      sinceH,
    );
    const ips = all<{ ip: string; kind: string; attempts: number; country: string | null; as_name: string | null; last_seen: number; logins_ok: number }>(
      `SELECT ip, kind, attempts, country, as_name, last_seen, logins_ok FROM attack_ip
        WHERE last_seen >= ? ORDER BY attempts DESC LIMIT 15`,
      since,
    );
    const countries = all<{ country: string | null; ips: number; attempts: number }>(
      `SELECT country, COUNT(DISTINCT ip) AS ips, SUM(attempts) AS attempts FROM attack_ip
        WHERE last_seen >= ? GROUP BY country ORDER BY attempts DESC LIMIT 12`,
      since,
    );
    const uniqueIps = (this.db.query("SELECT COUNT(DISTINCT ip) AS n FROM attack_ip WHERE last_seen >= ?").get(since) as {
      n: number;
    }).n;
    // Nuevas: su primera aparición cae dentro de la ventana; reincidentes: ya venían de antes.
    const fresh = (this.db
      .query(
        "SELECT COUNT(*) AS n FROM (SELECT ip FROM attack_ip GROUP BY ip HAVING MAX(last_seen) >= ?1 AND MIN(first_seen) >= ?1)",
      )
      .get(since) as { n: number }).n;
    const honeypot = this.db
      .query(
        "SELECT COALESCE(SUM(sessions), 0) AS sesiones, COALESCE(SUM(logins_ok), 0) AS logins FROM attack_ip WHERE kind IN ('ssh', 'telnet') AND last_seen >= ?",
      )
      .get(since) as { sesiones: number; logins: number };
    return {
      ventana_horas: hours,
      intentos_por_tipo: Object.fromEntries(byKind.map((r) => [r.kind, r.n])),
      ips_distintas: uniqueIps,
      ips_nuevas: fresh,
      ips_reincidentes: uniqueIps - fresh,
      honeypot_sesiones: honeypot.sesiones,
      honeypot_logins: honeypot.logins,
      linea_de_tiempo: timeline,
      /** Siempre 7 días por hora (para el mapa de calor día × hora). */
      por_hora_7d: all<{ hour: number; n: number }>(
        "SELECT hour, SUM(n) AS n FROM attack_hourly WHERE hour >= ? GROUP BY hour ORDER BY hour",
        Math.floor(now / HOUR) - 7 * 24 + 1,
      ),
      /** Cliente SSH que dice usar cada bot (libssh, Go, paramiko…), del honeypot. */
      clientes: all<{ client: string; ips: number }>(
        "SELECT client, COUNT(DISTINCT ip) AS ips FROM attack_ip WHERE client IS NOT NULL GROUP BY client ORDER BY ips DESC LIMIT 10",
      ),
      contrasenas: passwordStats(
        all<{ password: string; n: number }>(
          "SELECT k2 AS password, SUM(n) AS n FROM attack_stat WHERE stat = 'cred' AND hour >= ? GROUP BY k2",
          sinceH,
        ),
      ),
      redes: all<{ as_name: string | null; asn: number | null; country: string | null; ips: number; attempts: number }>(
        `SELECT as_name, asn, MAX(country) AS country, COUNT(DISTINCT ip) AS ips, SUM(attempts) AS attempts FROM attack_ip
          WHERE last_seen >= ? GROUP BY asn ORDER BY attempts DESC LIMIT 10`,
        since,
      ),
      top_ips: ips,
      /** Para las rutas del mapa: las 40 IPs que más atacan en la ventana, con su tipo. */
      origenes: all<{ ip: string; kind: string; attempts: number; country: string | null }>(
        "SELECT ip, kind, attempts, country FROM attack_ip WHERE last_seen >= ? AND country IS NOT NULL ORDER BY attempts DESC LIMIT 40",
        since,
      ),
      paises: countries,
      usuarios: all<{ kind: string; username: string; n: number }>(
        `SELECT kind, k1 AS username, SUM(n) AS n FROM attack_stat
          WHERE stat = 'user' AND hour >= ? GROUP BY kind, k1 ORDER BY n DESC LIMIT 15`,
        sinceH,
      ),
      credenciales: all<{ username: string; password: string; n: number }>(
        `SELECT k1 AS username, k2 AS password, SUM(n) AS n FROM attack_stat
          WHERE stat = 'cred' AND hour >= ? GROUP BY k1, k2 ORDER BY n DESC LIMIT 15`,
        sinceH,
      ),
      // Con JOIN: los comandos de IPs propias que `forget` borró de attack_cmd no salen.
      comandos: all<{ cmd: string; n: number; last_seen: number }>(
        `SELECT s.k1 AS cmd, SUM(s.n) AS n, MAX(c.last_seen) AS last_seen
           FROM attack_stat s JOIN attack_cmd c ON c.cmd = s.k1
          WHERE s.stat = 'cmd' AND s.hour >= ? GROUP BY s.k1 ORDER BY n DESC, last_seen DESC LIMIT 15`,
        sinceH,
      ),
      // Los archivos cazados son pocos y valiosos: siempre los últimos, sin ventana.
      descargas: all<{ sha256: string; url: string; ip: string; first_seen: number; n: number }>(
        "SELECT sha256, url, ip, first_seen, n FROM attack_download ORDER BY first_seen DESC LIMIT 10",
      ),
      rutas_web: all<{ path: string; n: number }>(
        `SELECT k1 AS path, SUM(n) AS n FROM attack_stat
          WHERE stat = 'path' AND hour >= ? GROUP BY k1 ORDER BY n DESC LIMIT 15`,
        sinceH,
      ),
      /** Intentos con hora real en los últimos 10 minutos (el marcador "en directo"). */
      ultimos_10_min: (this.db
        .query("SELECT COALESCE(SUM(MAX(count, 1)), 0) AS n FROM attack_feed WHERE ts >= ?")
        .get(now - 10 * 60_000) as { n: number }).n,
      feed: all<{ ts: number; kind: string; ip: string; country: string | null; count: number; text: string }>(
        "SELECT ts, kind, ip, country, count, text FROM attack_feed ORDER BY ts DESC, id DESC LIMIT 40",
      ),
    };
  }
}
