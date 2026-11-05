import { config } from "./config";

/** Día y hora actuales en Madrid. */
export function madridClock(now: Date): { day: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

/**
 * Decide si toca la tarea diaria: true una sola vez por día al llegar `hour`
 * (hora de Madrid). Si se crea después de esa hora, ese día ya no toca.
 */
export function dailyTrigger(hour: number, start: Date) {
  const s = madridClock(start);
  let lastDay = s.hour >= hour ? s.day : "";
  return (now: Date): boolean => {
    const t = madridClock(now);
    if (t.hour !== hour || t.day === lastDay) return false;
    lastDay = t.day;
    return true;
  };
}

/**
 * Llama a `fn` una vez al día a `hour` (Madrid). Comprueba cada minuto en vez
 * de programar un setTimeout largo: así ni los cambios de hora ni una
 * suspensión del equipo lo desajustan.
 */
export function daily(hour: number, fn: () => Promise<void>) {
  const due = dailyTrigger(hour, new Date());
  return setInterval(() => {
    if (due(new Date())) fn().catch((err) => console.error("tarea diaria fallida", err));
  }, 60_000);
}
