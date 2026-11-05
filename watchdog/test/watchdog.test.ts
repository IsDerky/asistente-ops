import { describe, expect, test } from "bun:test";
import { CHECKS, REMIND_EVERY_MIN } from "../src/checks";
import { markAlerted, recordPing, type Store, status, sweep } from "../src/watchdog";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 29, 12, 0);

function memoryStore(): Store {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
}

const servidorMax = CHECKS.servidor?.maxSilenceMin ?? 0;

/** Lo que haría el cron: barrer y marcar lo que se ha enviado. */
async function cron(store: Store, now: number) {
  const alerts = await sweep(store, now);
  for (const a of alerts) await markAlerted(store, a, now);
  return alerts;
}

describe("vigilante", () => {
  test("una señal que nunca ha llegado no avisa", async () => {
    expect(await cron(memoryStore(), T0)).toEqual([]);
  });

  test("dentro del límite no avisa", async () => {
    const s = memoryStore();
    await recordPing(s, "servidor", T0);
    expect(await cron(s, T0 + (servidorMax - 1) * MIN)).toEqual([]);
  });

  test("avisa una vez al pasarse y no repite hasta el recordatorio", async () => {
    const s = memoryStore();
    await recordPing(s, "servidor", T0);
    const first = await cron(s, T0 + servidorMax * MIN);
    expect(first.map((a) => [a.kind, a.name])).toEqual([["down", "servidor"]]);
    expect(await cron(s, T0 + (servidorMax + 5) * MIN)).toEqual([]);
    const later = await cron(s, T0 + (servidorMax + REMIND_EVERY_MIN) * MIN);
    expect(later.map((a) => a.kind)).toEqual(["reminder"]);
  });

  test("si el DM falla (sin marcar) se reintenta en la siguiente pasada", async () => {
    const s = memoryStore();
    await recordPing(s, "servidor", T0);
    expect(await sweep(s, T0 + servidorMax * MIN)).toHaveLength(1);
    expect(await sweep(s, T0 + (servidorMax + 5) * MIN)).toHaveLength(1);
  });

  test("al volver la señal avisa de la recuperación con el tiempo caído", async () => {
    const s = memoryStore();
    await recordPing(s, "servidor", T0);
    await cron(s, T0 + 40 * MIN);
    const recovered = await recordPing(s, "servidor", T0 + 90 * MIN);
    expect(recovered?.kind).toBe("recovered");
    expect(recovered?.minutes).toBe(90);
    expect(await recordPing(s, "servidor", T0 + 95 * MIN)).toBeNull();
    expect(await cron(s, T0 + 96 * MIN)).toEqual([]);
  });

  test("cada señal va por su cuenta", async () => {
    const s = memoryStore();
    await recordPing(s, "servidor", T0);
    await recordPing(s, "backup-sistema", T0);
    const alerts = await cron(s, T0 + 13 * 60 * MIN);
    expect(alerts.map((a) => a.name).sort()).toEqual(["backup-sistema", "servidor"]);
  });

  test("rechaza señales desconocidas", async () => {
    expect(recordPing(memoryStore(), "otra", T0)).rejects.toThrow();
  });

  test("status lista todas las señales", async () => {
    const s = memoryStore();
    await recordPing(s, "servidor", T0);
    const st = await status(s, T0 + 3 * MIN);
    expect(st.find((x) => x.name === "servidor")?.minutesSilent).toBe(3);
    expect(st.find((x) => x.name === "backup-clientes")?.lastPing).toBeNull();
  });
});
