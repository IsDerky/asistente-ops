import type { Database } from "bun:sqlite";
import { config } from "./config";
import { isError, type Snapshot } from "./data";

/**
 * Caducidades: certificados (del snapshot), dominios (RDAP, una vez al día) y
 * recordatorios que apunta Alex ("Google One se renueva el …"). Avisa por DM
 * al cruzar cada umbral, una sola vez por umbral.
 */
export interface Expiry {
  key: string;
  what: string;
  kind: "certificado" | "dominio" | "recordatorio";
  /** YYYY-MM-DD */
  day: string;
  days_left: number;
  notes?: string;
  /** Solo los recordatorios, para poder borrarlos. */
  id?: number;
}

/**
 * certbot renueva solo a 30 días: un certificado a menos de 20 es que la
 * renovación ha fallado. El resto, con un mes de margen.
 */
const THRESHOLDS: Record<Expiry["kind"], number[]> = {
  certificado: [20, 7, 2],
  dominio: [30, 7, 1],
  recordatorio: [30, 7, 1],
};

const DAY = 86_400_000;
const RDAP_EVERY_MS = DAY;

export type FetchJson = (url: string) => Promise<unknown>;

const defaultFetch: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
  if (!res.ok) throw new Error(`RDAP respondió ${res.status}`);
  return res.json();
};

function daysLeft(day: string, now: number): number {
  return Math.floor((Date.parse(`${day}T23:59:59Z`) - now) / DAY);
}

export class Expiries {
  constructor(
    readonly db: Database,
    private readonly fetchJson: FetchJson = defaultFetch,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reminder (
        id INTEGER PRIMARY KEY,
        what TEXT NOT NULL,
        day TEXT NOT NULL,
        notes TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS domain_expiry (
        domain TEXT PRIMARY KEY,
        day TEXT,
        error TEXT,
        checked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS expiry_notice (
        key TEXT NOT NULL,
        day TEXT NOT NULL,
        threshold INTEGER NOT NULL,
        sent_at INTEGER NOT NULL,
        PRIMARY KEY (key, day, threshold)
      );
    `);
  }

  addReminder(what: string, day: string, notes?: string): number {
    return Number(
      this.db
        .prepare("INSERT INTO reminder (what, day, notes, created_at) VALUES (?, ?, ?, ?)")
        .run(what, day, notes ?? null, Date.now()).lastInsertRowid,
    );
  }

  removeReminder(id: number): boolean {
    return this.db.prepare("DELETE FROM reminder WHERE id = ?").run(id).changes > 0;
  }

  /** Refresca por RDAP los dominios que no se han mirado hoy. Nunca lanza. */
  async refreshDomains(domains = config.domains, now = Date.now()): Promise<void> {
    for (const domain of domains) {
      const row = this.db.query("SELECT checked_at FROM domain_expiry WHERE domain = ?").get(domain) as {
        checked_at: number;
      } | null;
      if (row && now - row.checked_at < RDAP_EVERY_MS) continue;
      let day: string | null = null;
      let error: string | null = null;
      try {
        const data = (await this.fetchJson(`https://rdap.org/domain/${domain}`)) as {
          events?: Array<{ eventAction: string; eventDate: string }>;
        };
        const exp = data.events?.find((e) => e.eventAction === "expiration")?.eventDate;
        if (exp) day = exp.slice(0, 10);
        else error = "RDAP no da fecha de caducidad";
      } catch (err) {
        error = (err as Error).message;
      }
      this.db.run(
        `INSERT INTO domain_expiry (domain, day, error, checked_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (domain) DO UPDATE SET day = COALESCE(?2, day), error = ?3, checked_at = ?4`,
        [domain, day, error, now],
      );
    }
  }

  /** Todo lo que caduca, de lo más próximo a lo más lejano. */
  list(snap: Snapshot | null, now = Date.now()): { items: Expiry[]; errors: string[] } {
    const items: Expiry[] = [];
    const errors: string[] = [];

    const certs = snap?.certificates;
    if (certs && isError(certs)) errors.push(`certificados: ${certs.error}`);
    else if (certs) {
      for (const [name, c] of Object.entries(certs)) {
        if (!c.expires_at) {
          errors.push(`certificado ${name}: ${c.error ?? "sin fecha"}`);
          continue;
        }
        const day = c.expires_at.slice(0, 10);
        items.push({ key: `cert:${name}`, what: `Certificado ${name}`, kind: "certificado", day, days_left: daysLeft(day, now) });
      }
    }

    const domains = this.db.query("SELECT domain, day, error FROM domain_expiry").all() as Array<{
      domain: string;
      day: string | null;
      error: string | null;
    }>;
    for (const d of domains) {
      if (d.error) errors.push(`dominio ${d.domain}: ${d.error}`);
      if (d.day) {
        items.push({ key: `domain:${d.domain}`, what: `Dominio ${d.domain}`, kind: "dominio", day: d.day, days_left: daysLeft(d.day, now) });
      }
    }

    const reminders = this.db.query("SELECT id, what, day, notes FROM reminder").all() as Array<{
      id: number;
      what: string;
      day: string;
      notes: string | null;
    }>;
    for (const r of reminders) {
      items.push({
        key: `reminder:${r.id}`,
        what: r.what,
        kind: "recordatorio",
        day: r.day,
        days_left: daysLeft(r.day, now),
        notes: r.notes ?? undefined,
        id: r.id,
      });
    }

    items.sort((a, b) => a.days_left - b.days_left);
    return { items, errors };
  }

  /**
   * Lo que acaba de cruzar un umbral y aún no se ha avisado. Lo marca como
   * avisado: llamar solo cuando el DM vaya a salir. Ya caducado cuenta como
   * umbral 0 (un aviso).
   */
  due(items: Expiry[], now = Date.now()): Array<Expiry & { threshold: number }> {
    const out: Array<Expiry & { threshold: number }> = [];
    const seen = this.db.prepare("SELECT 1 FROM expiry_notice WHERE key = ? AND day = ? AND threshold = ?");
    const mark = this.db.prepare("INSERT OR IGNORE INTO expiry_notice (key, day, threshold, sent_at) VALUES (?, ?, ?, ?)");
    for (const item of items) {
      const crossed = [0, ...THRESHOLDS[item.kind]].filter((t) => item.days_left <= t);
      if (crossed.length === 0) continue;
      // El umbral más pequeño cruzado; los mayores se marcan sin avisar (sin avalancha).
      const threshold = Math.min(...crossed);
      if (seen.get(item.key, item.day, threshold)) continue;
      for (const t of crossed) mark.run(item.key, item.day, t, now);
      out.push({ ...item, threshold });
    }
    return out;
  }
}
