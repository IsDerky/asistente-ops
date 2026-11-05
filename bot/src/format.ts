import { config } from "./config";

export function bytes(n: number | null | undefined): string {
  if (n == null) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function duration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} días ${h % 24} h`;
}

/** Fecha y hora legibles en Madrid, p. ej. "jue 29 oct, 09:00". */
export function madrid(date: Date | number | string): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: config.timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

/** Discord corta los mensajes en 2000 caracteres: trocea por líneas. */
export function chunks(text: string, max = 1900): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > max && current) {
      out.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line.slice(0, max);
  }
  if (current) out.push(current);
  return out.length > 0 ? out : [""];
}
