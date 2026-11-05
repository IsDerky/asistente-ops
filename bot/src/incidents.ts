import type { Database } from "bun:sqlite";

/**
 * Memoria de incidentes: qué pasó, por qué y cómo se arregló. El modelo la
 * consulta antes de diagnosticar ("¿esto ya pasó?") y propone apuntar los
 * nuevos; solo se guardan cuando Alex confirma con el botón.
 */
export interface Incident {
  id: number;
  day: string;
  title: string;
  symptom: string;
  cause: string;
  solution: string;
}

export type NewIncident = Omit<Incident, "id">;

/** Lo que ya ha pasado en el servidor, para no empezar con la memoria vacía. */
export const SEED_INCIDENTS: NewIncident[] = [
  {
    day: "2026-10-28",
    title: "El servidor no arrancaba tras un reinicio",
    symptom: "No pasaba el POST: LED fijo, sin vídeo y reinicios en bucle. Después, fsck y aviso 'Time-of-day not set'.",
    cause: "Probablemente la pila CMOS agotada; la BIOS volvió a valores por defecto (SATA en RAID On). La RAM no estaba rota (memtest OK).",
    solution: "Arrancar con un solo módulo en DIMM1 y volver a meter los demás de uno en uno. Pendiente: pila CR2032 nueva, AC Recovery = Power On y 'Continue on Warnings'. No tocar el modo SATA.",
  },
  {
    day: "2026-10-28",
    title: "Backup a Google Drive fallando por cuota",
    symptom: "server-backup fallaba con rateLimitExceeded / 403 'Quota exceeded … consumer project_number:202264815644'.",
    cause: "rclone usaba su client_id interno, compartido por todos sus usuarios.",
    solution: "Proyecto propio 'servidor-backup' en Google Cloud con app OAuth propia (drive.file); hubo que recrear el repositorio. RESTIC_PACK_SIZE=64 para hacer menos peticiones.",
  },
  {
    day: "2026-10-28",
    title: "El latido al vigilante dejó de enviarse",
    symptom: "El vigilante externo avisó de que el servidor no daba señales aunque estaba encendido.",
    cause: "Un timer de systemd con solo OnBootSec + OnUnitActiveSec, activado con el sistema ya arrancado, se quedaba sin próxima ejecución.",
    solution: "Usar OnCalendar en los timers (ops-ping-servidor, ops-collect).",
  },
  {
    day: "2026-10-28",
    title: "Wings en bucle de reinicios",
    symptom: "wings.service se reiniciaba sin parar; logs con 'failed to load server configurations' y errores de certificado al llamar al panel.",
    cause: "Wings no llega al panel por la IP pública desde dentro de la LAN (el router no hace NAT de vuelta).",
    solution: "Añadir '127.0.0.1 <dominio del panel>' a /etc/hosts (copia en /etc/hosts.bak).",
  },
  {
    day: "2026-10-28",
    title: "Bentonime respondía 429 a todo",
    symptom: "Todas las peticiones daban 'demasiadas peticiones' (429) tras un problema con la hora del sistema.",
    cause: "El rate limit no limitaba el tiempo transcurrido a ≥ 0: un salto del reloj hacia atrás vaciaba los buckets.",
    solution: "Math.max(0, now - bucket.lastRefillMs) en src/lib/rate-limit.ts.",
  },
  {
    day: "2026-10-29",
    title: "Descargas offline de Bentonime desaparecidas",
    symptom: "Los episodios descargados dejaban de aparecer tras unos cuantos deploys.",
    cause: "episode_file.path guardaba la ruta dentro de ~/apps/releases/<sha>/, que se borra al rotar versiones.",
    solution: "Derivar la ruta de offlineFilePath(episodeId) y re-registrar los .mp4 huérfanos.",
  },
  {
    day: "2026-10-29",
    title: "Se colaban anuncios pese a AdGuard",
    symptom: "Algunas webs seguían mostrando anuncios en el PC.",
    cause: "Chrome tenía activado su DNS seguro (se saltaba AdGuard) y Windows consultaba en paralelo el DNS alternativo 1.1.1.1.",
    solution: "Desactivar el DNS seguro de Chrome y dejar en Windows solo el servidor (DoH al AdGuard).",
  },
  {
    day: "2026-10-29",
    title: "El DoH de Windows no funcionaba con AdGuard",
    symptom: "Windows no resolvía usando el endpoint DoH de AdGuard detrás de nginx.",
    cause: "El cliente DoH de Windows no usa HTTP/1.1 y nginx no tenía http2 en ese servidor.",
    solution: "Activar http2 en el bloque de nginx del DoH.",
  },
  {
    day: "2026-10-28",
    title: "syslog inundado",
    symptom: "syslog.1 llegó a 567 MB en una semana y el journal a 3,1 GB.",
    cause: "Sin confirmar; paró tras la limpieza de restos de escritorio del 2026-10-28. Hoy los avisos más numerosos son los fallos de login del SFTP de Wings (fuerza bruta desde internet) y [UFW BLOCK] de multicast de la LAN.",
    solution: "Journal limitado a 500 MB. Si vuelve, mirar qué unidad escribe más con journalctl.",
  },
];

export class Incidents {
  constructor(
    readonly db: Database,
    seed = SEED_INCIDENTS,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS incident (
        id INTEGER PRIMARY KEY,
        day TEXT NOT NULL,
        title TEXT NOT NULL,
        symptom TEXT NOT NULL,
        cause TEXT NOT NULL,
        solution TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS incident_fts USING fts5(
        title, symptom, cause, solution,
        content = 'incident', content_rowid = 'id',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS incident_ai AFTER INSERT ON incident BEGIN
        INSERT INTO incident_fts (rowid, title, symptom, cause, solution)
        VALUES (new.id, new.title, new.symptom, new.cause, new.solution);
      END;
    `);
    if (db.query("SELECT 1 FROM incident LIMIT 1").get() == null) {
      db.transaction(() => {
        for (const i of seed) this.add(i);
      })();
    }
  }

  add(i: NewIncident): number {
    return Number(
      this.db
        .prepare("INSERT INTO incident (day, title, symptom, cause, solution) VALUES (?, ?, ?, ?, ?)")
        .run(i.day, i.title, i.symptom, i.cause, i.solution).lastInsertRowid,
    );
  }

  /**
   * Búsqueda por palabras (cualquiera de ellas, por prefijo, sin tildes). Sin
   * palabras útiles, los más recientes.
   */
  search(text: string, limit = 5): Incident[] {
    const words = text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu);
    if (!words?.length) return this.recent(limit);
    const query = [...new Set(words)].map((w) => `"${w}"*`).join(" OR ");
    return this.db
      .query(
        `SELECT i.* FROM incident_fts f JOIN incident i ON i.id = f.rowid
          WHERE incident_fts MATCH ? ORDER BY bm25(incident_fts) LIMIT ?`,
      )
      .all(query, limit) as Incident[];
  }

  recent(limit = 5): Incident[] {
    return this.db.query("SELECT * FROM incident ORDER BY day DESC, id DESC LIMIT ?").all(limit) as Incident[];
  }
}
