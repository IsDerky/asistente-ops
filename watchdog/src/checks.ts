/**
 * Señales que el servidor manda al vigilante y cuánto silencio se tolera antes
 * de avisar. Añadir una aquí basta: el servidor solo tiene que hacer
 * `ops-ping <nombre>`.
 */
export interface Check {
  label: string;
  /** Minutos sin señal a partir de los cuales se avisa. */
  maxSilenceMin: number;
  /** Qué suele significar el silencio, para el DM. */
  hint: string;
}

export const CHECKS: Record<string, Check> = {
  servidor: {
    label: "Servidor",
    maxSilenceMin: 15,
    hint: "El OptiPlex no responde: corte de luz, sin red o parado en la BIOS (pila CMOS).",
  },
  "backup-sistema": {
    label: "Backup del sistema",
    // Se hace cada 6 h: avisar tras dos copias perdidas.
    maxSilenceMin: 13 * 60,
    hint: "Revisa `journalctl -u server-backup@sistema` y el timer.",
  },
  "backup-clientes": {
    label: "Backup de clientes",
    maxSilenceMin: 30 * 60,
    hint: "Revisa `journalctl -u server-backup@clientes` y el timer.",
  },
  simulacro: {
    label: "Simulacro de restauración",
    // Mensual (primer domingo): avisar si se salta uno entero.
    maxSilenceMin: 40 * 24 * 60,
    hint: "Revisa `journalctl -u server-backup@simulacro` y `systemctl list-timers server-backup-simulacro.timer`.",
  },
};

/** Mientras siga caído, recordarlo cada tanto en vez de una sola vez. */
export const REMIND_EVERY_MIN = 24 * 60;
