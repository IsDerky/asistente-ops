import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import type { AttackKind, AttackRecord } from "./attacks";
import { config } from "./config";
import type { Result } from "./data";

/**
 * Detector de anomalías en logs. El recolector (root) lee el journal con
 * cursor y deja en logs.json lotes de avisos agrupados por huella (el mensaje
 * sin números, IDs, IPs ni rutas). Aquí se decide qué es raro:
 *  - una huella nunca vista → aviso (salvo en el aprendizaje inicial);
 *  - una conocida que se dispara (10× su media por hora) → aviso;
 *  - lo demás solo suma al contador.
 * Los bloqueos de ufw no son huellas del recolector: se cuentan como una sola
 * y solo avisan si se disparan. Casi todos son multicast de la LAN (el router
 * solo reenvía puertos que ufw ya permite); un pico sí sería raro.
 */

export interface LogPattern {
  fp: string;
  unit: string;
  template: string;
  sample: string;
  priority: number;
  count: number;
}

export interface LogBatch {
  id: number;
  at: string;
  /** El primer lote: 7 días para aprender lo normal. No avisa. */
  seed: boolean;
  ufw_blocks: number;
  patterns: LogPattern[];
  /** Ataques por (tipo, IP). Falta en lotes de versiones antiguas del recolector. */
  attacks?: AttackRecord[];
  /** Fallos de SFTP que podrían ser de clientes: solo el número. */
  sftp_failed_other?: number;
  /** IPs públicas propias (NAT de vuelta al probar desde el PC): ni son ataques ni se guardan. */
  own_ips?: string[];
  /** Una sola vez: tablas por ventana rehechas desde los logs (registros por IP y hora). */
  stats_rebuild?: { kinds: AttackKind[]; until: number; attacks: AttackRecord[] };
}

export interface Anomaly {
  kind: "nuevo" | "pico";
  fp: string;
  unit: string;
  sample: string;
  /** Veces en este lote (nuevo) o en la hora en curso (pico). */
  count: number;
  /** Media por hora de los últimos días (solo picos). */
  baseline?: number;
}

export const UFW_FP = "ufw-block";
const SPIKE_FACTOR = 10;
/** Por debajo de esto no es un pico aunque la media sea casi cero. */
const SPIKE_MIN_PER_HOUR = 30;
/** Historia mínima para juzgar un pico: un patrón recién nacido no tiene media. */
const SPIKE_MIN_HISTORY_H = 24;
const BASELINE_H = 7 * 24;
const SPIKE_COOLDOWN_MS = 6 * 3600_000;
const KEEP_HOURLY_DAYS = 30;
const HOUR = 3600_000;

interface PatternRow {
  fp: string;
  unit: string;
  sample: string;
  first_seen: number;
  muted: number;
  last_alert: number | null;
}

export async function readLogBatches(path = config.logsPath): Promise<Result<LogBatch[]>> {
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as { batches?: LogBatch[] };
    return data.batches ?? [];
  } catch (err) {
    return { error: `no se pudo leer ${path}: ${(err as Error).message}` };
  }
}

export class LogWatch {
  constructor(readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS log_pattern (
        fp TEXT PRIMARY KEY,
        unit TEXT NOT NULL,
        template TEXT NOT NULL,
        sample TEXT NOT NULL,
        priority INTEGER NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        total INTEGER NOT NULL,
        learned INTEGER NOT NULL DEFAULT 0,
        muted INTEGER NOT NULL DEFAULT 0,
        last_alert INTEGER
      );
      CREATE TABLE IF NOT EXISTS log_hourly (
        fp TEXT NOT NULL,
        hour INTEGER NOT NULL,
        n INTEGER NOT NULL,
        PRIMARY KEY (fp, hour)
      );
      CREATE TABLE IF NOT EXISTS log_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  /** Procesa los lotes que aún no ha visto y devuelve lo que merece un aviso. */
  ingest(batches: LogBatch[]): Anomaly[] {
    const last = Number(this.meta("last_batch") ?? 0);
    const fresh = batches.filter((b) => b.id > last).sort((a, b) => a.id - b.id);
    const anomalies: Anomaly[] = [];
    if (fresh.length === 0) return anomalies;

    const get = this.db.prepare("SELECT fp, unit, sample, first_seen, muted, last_alert FROM log_pattern WHERE fp = ?");
    const insert = this.db.prepare(
      `INSERT INTO log_pattern (fp, unit, template, sample, priority, first_seen, last_seen, total, learned, last_alert)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?6)`,
    );
    const touch = this.db.prepare(
      "UPDATE log_pattern SET last_seen = ?2, total = total + ?3, sample = ?4 WHERE fp = ?1",
    );
    const addHourly = this.db.prepare(
      "INSERT INTO log_hourly (fp, hour, n) VALUES (?1, ?2, ?3) ON CONFLICT (fp, hour) DO UPDATE SET n = n + ?3",
    );
    const hourly = this.db.prepare("SELECT n FROM log_hourly WHERE fp = ? AND hour = ?");
    const baseline = this.db.prepare(
      "SELECT COALESCE(SUM(n), 0) AS total FROM log_hourly WHERE fp = ?1 AND hour >= ?2 AND hour < ?3",
    );
    const alerted = this.db.prepare("UPDATE log_pattern SET last_alert = ?2 WHERE fp = ?1");

    this.db.transaction(() => {
      for (const b of fresh) {
        const ts = Date.parse(b.at);
        const hour = Math.floor(ts / HOUR);
        // Sin nada aprendido todavía (p. ej. el lote semilla ya rotó), se aprende igual.
        const learning = b.seed || this.isEmpty();
        const patterns = [...b.patterns];
        if (b.ufw_blocks > 0) {
          patterns.push({
            fp: UFW_FP,
            unit: "kernel (ufw)",
            template: "[UFW BLOCK] conexión bloqueada",
            sample: "Paquetes bloqueados por el cortafuegos (normalmente multicast de la LAN)",
            priority: 4,
            count: b.ufw_blocks,
          });
        }
        for (const p of patterns) {
          addHourly.run(p.fp, hour, p.count);
          const known = get.get(p.fp) as PatternRow | null;
          if (!known) {
            insert.run(p.fp, p.unit, p.template, p.sample, p.priority, ts, p.count, learning ? 1 : 0);
            if (!learning && p.fp !== UFW_FP) {
              anomalies.push({ kind: "nuevo", fp: p.fp, unit: p.unit, sample: p.sample, count: p.count });
            }
            continue;
          }
          touch.run(p.fp, ts, p.count, p.sample);
          if (learning || known.muted) continue;

          const historyH = Math.min(BASELINE_H, hour - Math.floor(known.first_seen / HOUR));
          if (historyH < SPIKE_MIN_HISTORY_H) continue;
          const now = (hourly.get(p.fp, hour) as { n: number }).n;
          const avg = (baseline.get(p.fp, hour - historyH, hour) as { total: number }).total / historyH;
          const cooled = known.last_alert == null || ts - known.last_alert > SPIKE_COOLDOWN_MS;
          if (now >= SPIKE_MIN_PER_HOUR && now > SPIKE_FACTOR * avg && cooled) {
            alerted.run(p.fp, ts);
            anomalies.push({
              kind: "pico",
              fp: p.fp,
              unit: known.unit,
              sample: p.sample,
              count: now,
              baseline: Math.round(avg * 10) / 10,
            });
          }
        }
        this.setMeta("last_batch", String(b.id));
      }
      this.db.run("DELETE FROM log_hourly WHERE hour < ?", [
        Math.floor(Date.now() / HOUR) - KEEP_HOURLY_DAYS * 24,
      ]);
    })();
    return anomalies;
  }

  /** Silencia (o reactiva) huellas. Devuelve cuántas existían. */
  mute(fps: string[], muted = true): number {
    const stmt = this.db.prepare("UPDATE log_pattern SET muted = ? WHERE fp = ?");
    let n = 0;
    this.db.transaction(() => {
      for (const fp of fps) n += stmt.run(muted ? 1 : 0, fp).changes;
    })();
    return n;
  }

  /** Lo que ha pasado en los logs desde `sinceMs`, para el modelo. */
  recent(sinceMs: number) {
    const sinceH = Math.floor(sinceMs / HOUR);
    const nuevos = this.db
      .query(
        `SELECT fp, unit, sample, first_seen, total, muted FROM log_pattern
          WHERE learned = 0 AND first_seen >= ? ORDER BY first_seen DESC LIMIT 20`,
      )
      .all(sinceMs) as Array<{ fp: string; unit: string; sample: string; first_seen: number; total: number; muted: number }>;
    const top = this.db
      .query(
        `SELECT p.fp, p.unit, p.sample, SUM(h.n) AS veces, p.muted
           FROM log_hourly h JOIN log_pattern p ON p.fp = h.fp
          WHERE h.hour >= ? GROUP BY h.fp ORDER BY veces DESC LIMIT 10`,
      )
      .all(sinceH) as Array<{ fp: string; unit: string; sample: string; veces: number; muted: number }>;
    const silenciados = this.db
      .query("SELECT fp, unit, sample FROM log_pattern WHERE muted = 1 ORDER BY last_seen DESC LIMIT 20")
      .all() as Array<{ fp: string; unit: string; sample: string }>;
    const ufw = this.db
      .query("SELECT COALESCE(SUM(n), 0) AS n FROM log_hourly WHERE fp = ? AND hour >= ?")
      .get(UFW_FP, sinceH) as { n: number };
    return { nuevos, top, silenciados, bloqueos_ufw: ufw.n };
  }

  private isEmpty(): boolean {
    return this.db.query("SELECT 1 FROM log_pattern LIMIT 1").get() == null;
  }

  private meta(key: string): string | null {
    const row = this.db.query("SELECT value FROM log_meta WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string) {
    this.db.run("INSERT INTO log_meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2", [
      key,
      value,
    ]);
  }
}
