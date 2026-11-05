/**
 * Configuración desde el entorno (en el servidor: /etc/asistente.env, cargado
 * por systemd). Falla al arrancar si falta algo imprescindible.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

/**
 * Único usuario de Discord al que el bot atiende. Fijado en el código a
 * propósito: un .env mal escrito no puede abrirle la puerta a nadie más.
 * Pon aquí tu ID (Discord → Ajustes → Avanzado → Modo desarrollador → Copiar ID).
 */
export const OWNER_DISCORD_ID = "PON_AQUI_TU_ID";

export const config = {
  discordToken: () => required("DISCORD_BOT_TOKEN"),
  ownerId: (owner = OWNER_DISCORD_ID) => {
    if (!/^\d{17,20}$/.test(owner)) {
      throw new Error("Falta tu ID de Discord en OWNER_DISCORD_ID (bot/src/config.ts)");
    }
    const fromEnv = process.env.DISCORD_USER_ID;
    if (fromEnv && fromEnv !== owner) {
      throw new Error(`DISCORD_USER_ID (${fromEnv}) no coincide con el owner (${owner})`);
    }
    return owner;
  },

  groqApiKey: () => required("GROQ_API_KEY"),
  /** Ver los disponibles con `bun src/cli.ts modelos`. */
  model: process.env.ASSISTANT_MODEL ?? "openai/gpt-oss-120b",
  /** Solo para modelos que razonan (gpt-oss). Con "low" usaba peor las herramientas. */
  chatEffort: (process.env.ASSISTANT_CHAT_EFFORT ?? "medium") as Effort,
  /** …y algo más de criterio para el resumen diario. */
  summaryEffort: (process.env.ASSISTANT_SUMMARY_EFFORT ?? "medium") as Effort,

  snapshotPath: process.env.OPS_SNAPSHOT ?? "/var/lib/ops-collect/snapshot.json",
  logsPath: process.env.OPS_LOGS ?? "/var/lib/ops-collect/logs.json",
  /** Dominios cuya caducidad se vigila (RDAP), separados por comas. */
  domains: (process.env.OPS_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean),
  dataDir: process.env.ASSISTANT_DATA_DIR ?? "/var/lib/asistente",

  bentonimeUrl: process.env.BENTONIME_URL ?? "http://127.0.0.1:3939",
  bentonimeToken: process.env.OPS_API_TOKEN ?? "",

  watchdogUrl: process.env.OPS_WATCHDOG_URL ?? "",
  watchdogToken: process.env.OPS_WATCHDOG_TOKEN ?? "",

  /** Panel de Pterodactyl: Application API con clave de SOLO LECTURA. Sin clave, desactivado. */
  pterodactylUrl: process.env.PTERODACTYL_URL ?? "",
  pterodactylKey: process.env.PTERODACTYL_API_KEY ?? "",

  /** API de solo lectura para la oficina (nginx la publica solo en la LAN). */
  apiPort: Number(process.env.ASSISTANT_API_PORT ?? 9300),
  /** Token de los hooks de Claude Code del PC (POST /api/claude/hook). Sin token, desactivado. */
  claudeHookToken: process.env.CLAUDE_HOOK_TOKEN ?? "",

  /** Lo que suena en Spotify, para la sala audiovisual: el widget del portfolio. Vacío, desactivado. */
  spotifyNowUrl: process.env.SPOTIFY_NOW_URL ?? "",

  /**
   * Obras en la oficina: los despliegues (CI/CD de oficina, honeypot…) dejan
   * aquí un archivo con el nombre del repo mientras trabajan y lo borran al acabar.
   */
  worksDir: process.env.OFICINA_OBRAS_DIR ?? "/run/oficina-obras",

  /** Dónde mirar el tiempo para las ventanas de la oficina (por defecto, Madrid). */
  weatherLat: Number(process.env.OFICINA_LAT ?? 40.4168),
  weatherLon: Number(process.env.OFICINA_LON ?? -3.7038),

  /** Hora local (Europe/Madrid) del resumen diario. */
  summaryHour: Number(process.env.ASSISTANT_SUMMARY_HOUR ?? 9),
  timezone: "Europe/Madrid",
};

export type Effort = "low" | "medium" | "high";
