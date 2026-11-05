import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config";
import type { Snapshot } from "./data";

/**
 * Histórico propio del asistente (SQLite). Guarda una muestra de RAM/CPU de
 * cada contenedor por snapshot, para responder "pico de RAM de las últimas
 * 24 h" sin tener que preguntarle a nadie más. Se conserva 14 días.
 */
const KEEP_DAYS = 14;

export class History {
  readonly db: Database;

  constructor(path = join(config.dataDir, "asistente.db")) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS container_sample (
        ts INTEGER NOT NULL,
        container TEXT NOT NULL,
        server TEXT,
        mem_bytes INTEGER,
        cpu_pct REAL,
        PRIMARY KEY (ts, container)
      );
      CREATE INDEX IF NOT EXISTS container_sample_ts ON container_sample (ts);
    `);
  }

  /** Guarda las muestras de un snapshot. Idempotente por `collected_at`. */
  record(snap: Snapshot): number {
    const containers = snap.containers;
    if (!Array.isArray(containers)) return 0;
    const ts = Date.parse(snap.collected_at);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO container_sample (ts, container, server, mem_bytes, cpu_pct) VALUES (?, ?, ?, ?, ?)",
    );
    let n = 0;
    this.db.transaction(() => {
      for (const c of containers) {
        n += insert.run(ts, c.container, c.server, c.mem_bytes, c.cpu_pct).changes;
      }
    })();
    this.db.run("DELETE FROM container_sample WHERE ts < ?", [Date.now() - KEEP_DAYS * 86_400_000]);
    return n;
  }

  /** Pico de RAM y CPU media por contenedor desde `sinceMs`. */
  peaks(sinceMs: number): Array<{
    container: string;
    server: string | null;
    peak_mem_bytes: number;
    peak_at: number;
    avg_cpu_pct: number;
    samples: number;
  }> {
    return this.db
      .query(
        `SELECT s.container, s.server, s.mem_bytes AS peak_mem_bytes, s.ts AS peak_at,
                agg.avg_cpu AS avg_cpu_pct, agg.samples
           FROM container_sample s
           JOIN (SELECT container, MAX(mem_bytes) AS max_mem, AVG(cpu_pct) AS avg_cpu, COUNT(*) AS samples
                   FROM container_sample WHERE ts >= ?1 GROUP BY container) agg
             ON agg.container = s.container AND s.mem_bytes = agg.max_mem
          WHERE s.ts >= ?1
          GROUP BY s.container
          ORDER BY peak_mem_bytes DESC`,
      )
      .all(sinceMs) as ReturnType<History["peaks"]>;
  }
}
