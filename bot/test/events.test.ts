import { describe, expect, test } from "bun:test";
import { openContext } from "../src/context";
import { diffLive, diffSnap, type Live } from "../src/events";

const unit = (active: string, result = "success", exitTs = 0) => ({ active, result, exitTs });

function live(over: Partial<Live> = {}, units: Record<string, ReturnType<typeof unit>> = {}): Live {
  return {
    units: {
      "server-backup@sistema.service": unit("inactive", "success", 100),
      "bentonime.service": unit("active"),
      ...units,
    },
    runnerBusy: false,
    downloads: { running: 0, queued: 0, episodes: [], failures: [] },
    ...over,
  };
}

describe("eventos en vivo", () => {
  test("la primera foto no genera eventos", () => {
    expect(diffLive(null, live())).toEqual([]);
  });

  test("backup: empieza, termina bien o falla; uno rápido que no se vio empezar también cuenta", () => {
    const running = live({}, { "server-backup@sistema.service": unit("activating", "success", 100) });
    expect(diffLive(live(), running).map((e) => e.type)).toEqual(["backup.start"]);
    const done = live({}, { "server-backup@sistema.service": unit("inactive", "success", 200) });
    expect(diffLive(running, done)).toEqual([
      { type: "backup.ok", level: "ok", text: "Terminado el backup de sistema", data: { mode: "sistema" } },
    ]);
    const failed = live({}, { "server-backup@sistema.service": unit("failed", "exit-code", 300) });
    expect(diffLive(done, failed)[0]).toMatchObject({ type: "backup.fail", level: "error" });
    const quick = live({}, { "server-backup@sistema.service": unit("inactive", "success", 999) });
    expect(diffLive(done, quick).map((e) => e.type)).toEqual(["backup.ok"]);
  });

  test("servicios que se caen y vuelven", () => {
    const down = live({}, { "bentonime.service": unit("failed") });
    expect(diffLive(live(), down)).toEqual([{ type: "service.down", level: "error", text: "Se ha caído Bentonime", data: { unit: "bentonime.service" } }]);
    expect(diffLive(down, live())[0]?.type).toBe("service.up");
  });

  test("deploy y descargas: empieza, episodio nuevo, listo y fallo", () => {
    expect(diffLive(live(), live({ runnerBusy: true }))[0]?.type).toBe("deploy.start");
    const ep = { anime: "Frieren", slug: "frieren", number: 4, downloaded: false };
    const a = live({ downloads: { running: 0, queued: 0, episodes: [], failures: [] } });
    const b = live({ downloads: { running: 1, queued: 2, episodes: [ep], failures: [] } });
    expect(diffLive(a, b).map((e) => e.type)).toEqual(["download.start", "episode.new"]);
    const c = live({ downloads: { running: 0, queued: 2, episodes: [{ ...ep, downloaded: true }], failures: [{ anime: "X", number: 1, at: "t1" }] } });
    expect(diffLive(b, c).map((e) => [e.type, e.text])).toEqual([
      ["download.done", "Listo para ver: Frieren, episodio 4"],
      ["download.fail", "No se pudo descargar X, episodio 1"],
    ]);
    expect(diffLive(c, c)).toEqual([]);
  });
});

describe("eventos del recolector", () => {
  test("versión nueva y baneos nuevos (con país), sin repetir los viejos", () => {
    const prev = { release: "aaaaaaa111", banned: ["1.1.1.1"] };
    const cur = { release: "bbbbbbb222", banned: ["1.1.1.1", "2.2.2.2"] };
    expect(diffSnap(prev, cur, () => "RU")).toEqual([
      { type: "deploy.done", level: "ok", text: "Bentonime actualizado a la versión bbbbbbb", data: { release: "bbbbbbb222" } },
      { type: "ban", level: "ok", text: "fail2ban echa a 2.2.2.2 (RU)", data: { ip: "2.2.2.2", country: "RU" } },
    ]);
    expect(diffSnap(null, cur)).toEqual([]);
  });

  test("despliegue fallido: con vuelta atrás, sin ella, y nada si fue bien o no ha cambiado", () => {
    const dep = (at: string, phase: string, rollback = "") => ({ sha: "cccccccc33", phase, previous: "bbbbbbb", rollback, at });
    const base = { release: "bbbbbbb222", banned: [] };
    const ok = dep("t1", "ok");
    expect(diffSnap({ ...base, lastDeploy: null }, { ...base, lastDeploy: ok })).toEqual([]);
    const health = dep("t2", "health", "ok");
    expect(diffSnap({ ...base, lastDeploy: ok }, { ...base, lastDeploy: health })).toEqual([
      {
        type: "deploy.fail",
        level: "warn",
        text: "Falló el despliegue de ccccccc (health): vuelta a bbbbbbb",
        data: { sha: "cccccccc33", phase: "health", rollback: "ok", previous: "bbbbbbb" },
      },
    ]);
    // El mismo archivo en la pasada siguiente no se repite.
    expect(diffSnap({ ...base, lastDeploy: health }, { ...base, lastDeploy: health })).toEqual([]);
    expect(diffSnap({ ...base, lastDeploy: ok }, { ...base, lastDeploy: dep("t3", "compilar") })[0]?.text).toBe(
      "Falló el despliegue de ccccccc (compilar); sigue la versión de antes",
    );
    expect(diffSnap({ ...base, lastDeploy: ok }, { ...base, lastDeploy: dep("t4", "health", "fallida") })[0]?.level).toBe("error");
  });

  test("espectadores de Bentonime: entra, sale y rechazados (sin repetir)", () => {
    const a = { key: "k1", name: "ana" };
    const b = { key: "k2", name: "bea" };
    const r1 = { name: "intruso", at: "2026-10-29T15:00:00Z" };
    const ev = diffLive(live({ viewers: [a], rejections: [] }), live({ viewers: [b], rejections: [r1] }));
    expect(ev.map((e) => `${e.type}:${String(e.data?.name)}`)).toEqual(["viewer.arrive:bea", "viewer.leave:ana", "viewer.rejected:intruso"]);
    expect(diffLive(live({ viewers: [b], rejections: [r1] }), live({ viewers: [b], rejections: [r1] }))).toEqual([]);
    // Sin datos de antes (bot recién arrancado o Bentonime antiguo): nada.
    expect(diffLive(live({ viewers: null }), live({ viewers: [a] }))).toEqual([]);
  });

  test("certbot renueva: la caducidad avanza (y uno nuevo no cuenta como renovado)", () => {
    const base = { release: null, banned: [] };
    const ev = diffSnap(
      { ...base, certs: { panel: "2026-12-17T00:00:00Z" } },
      { ...base, certs: { panel: "2027-03-17T00:00:00Z", nuevo: "2027-02-01T00:00:00Z" } },
    );
    expect(ev).toEqual([
      { type: "cert.renewed", level: "ok", text: "certbot renueva el certificado panel (hasta el 2027-03-17)", data: { name: "panel", until: "2027-03-17T00:00:00Z" } },
    ]);
  });

  test("una avalancha de baneos se resume", () => {
    const cur = { release: null, banned: Array.from({ length: 9 }, (_, i) => `9.9.9.${i}`) };
    const ev = diffSnap({ release: null, banned: [] }, cur);
    expect(ev).toHaveLength(6);
    expect(ev.at(-1)?.text).toBe("…y a 4 IPs más");
  });
});

describe("registro de eventos", () => {
  test("guarda, avisa a quien escucha, cuenta y devuelve lo último primero", () => {
    const { events } = openContext(":memory:");
    const seen: string[] = [];
    events.onEvent((e) => seen.push(e.type));
    events.push({ type: "backup.ok", level: "ok", text: "a", data: { mode: "sistema" } });
    events.push({ type: "ban", level: "ok", text: "b" });
    expect(seen).toEqual(["backup.ok", "ban"]);
    expect(events.recent(10).map((e) => e.type)).toEqual(["ban", "backup.ok"]);
    expect(events.recent(10)[1]?.data).toEqual({ mode: "sistema" });
    expect(events.count("backup.ok", 0)).toBe(1);
  });
});
