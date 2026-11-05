import { CHECKS, type Check, REMIND_EVERY_MIN } from "./checks";

/** Lo mínimo de KV que se usa; en los tests se sustituye por un Map. */
export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Alert {
  kind: "down" | "reminder" | "recovered";
  name: string;
  check: Check;
  /** Minutos sin señal (down/reminder) o que estuvo caído (recovered). */
  minutes: number;
}

const lastKey = (name: string) => `last:${name}`;
const alertKey = (name: string) => `alerted:${name}`;

/**
 * Registra una señal. Si esa señal estaba en alerta, la cierra y devuelve el
 * aviso de recuperación.
 */
export async function recordPing(store: Store, name: string, now: number): Promise<Alert | null> {
  const check = CHECKS[name];
  if (!check) throw new Error(`señal desconocida: ${name}`);
  const previous = Number((await store.get(lastKey(name))) ?? 0);
  await store.put(lastKey(name), String(now));
  if ((await store.get(alertKey(name))) == null) return null;
  await store.delete(alertKey(name));
  return { kind: "recovered", name, check, minutes: minutesBetween(previous, now) };
}

/**
 * Revisa todas las señales y devuelve los avisos pendientes. Una que nunca ha
 * llegado no avisa: así no salta nada antes de configurar el servidor. No
 * marca nada: eso lo hace `markAlerted` cuando el DM ha salido, para que un
 * fallo de Discord se reintente en la siguiente pasada.
 */
export async function sweep(store: Store, now: number): Promise<Alert[]> {
  const alerts: Alert[] = [];
  for (const [name, check] of Object.entries(CHECKS)) {
    const last = await store.get(lastKey(name));
    if (last == null) continue;
    const silence = minutesBetween(Number(last), now);
    if (silence < check.maxSilenceMin) continue;

    const alerted = await store.get(alertKey(name));
    if (alerted != null && minutesBetween(Number(alerted), now) < REMIND_EVERY_MIN) continue;
    alerts.push({ kind: alerted == null ? "down" : "reminder", name, check, minutes: silence });
  }
  return alerts;
}

export async function markAlerted(store: Store, alert: Alert, now: number): Promise<void> {
  if (alert.kind === "recovered") return;
  await store.put(alertKey(alert.name), String(now));
}

export interface Status {
  name: string;
  label: string;
  lastPing: string | null;
  minutesSilent: number | null;
  maxSilenceMin: number;
  alerting: boolean;
}

export async function status(store: Store, now: number): Promise<Status[]> {
  const out: Status[] = [];
  for (const [name, check] of Object.entries(CHECKS)) {
    const last = await store.get(lastKey(name));
    out.push({
      name,
      label: check.label,
      lastPing: last == null ? null : new Date(Number(last)).toISOString(),
      minutesSilent: last == null ? null : minutesBetween(Number(last), now),
      maxSilenceMin: check.maxSilenceMin,
      alerting: (await store.get(alertKey(name))) != null,
    });
  }
  return out;
}

function minutesBetween(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / 60_000));
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  if (h < 48) return `${h} h ${minutes % 60} min`;
  return `${Math.floor(h / 24)} días ${h % 24} h`;
}
