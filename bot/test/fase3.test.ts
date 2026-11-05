import { describe, expect, test } from "bun:test";
import { type Action, describeAction, runAction } from "../src/actions";
import { openContext } from "../src/context";
import { anomaliesEmbed, expiriesEmbed } from "../src/embeds";
import type { LogBatch, LogPattern } from "../src/logs";
import { UFW_FP } from "../src/logs";
import { callTool, buildTools } from "../src/tools";
import { logsView, simulacroView } from "../src/views";
import { snapshot } from "./fixtures";

const H = 3600_000;
const T0 = Date.parse("2026-10-20T00:00:00Z");

const pattern = (fp: string, count: number, unit = "wings.service"): LogPattern => ({
  fp,
  unit,
  template: `plantilla ${fp}`,
  sample: `ejemplo ${fp}`,
  priority: 3,
  count,
});

const batch = (hoursFromT0: number, patterns: LogPattern[], over: Partial<LogBatch> = {}): LogBatch => ({
  id: 1000 + hoursFromT0 * 12,
  at: new Date(T0 + hoursFromT0 * H).toISOString(),
  seed: false,
  ufw_blocks: 0,
  patterns,
  ...over,
});

describe("anomalías en logs", () => {
  test("el lote semilla aprende sin avisar; luego avisa de lo nuevo una sola vez", () => {
    const { logs } = openContext(":memory:");
    expect(logs.ingest([batch(0, [pattern("aaa", 50)], { seed: true })])).toEqual([]);
    const a = logs.ingest([batch(1, [pattern("aaa", 2), pattern("bbb", 1, "bentonime.service")])]);
    expect(a).toEqual([{ kind: "nuevo", fp: "bbb", unit: "bentonime.service", sample: "ejemplo bbb", count: 1 }]);
    // El mismo lote otra vez (el archivo guarda los últimos): no repite.
    expect(logs.ingest([batch(1, [pattern("bbb", 1)])])).toEqual([]);
    expect(logs.ingest([batch(2, [pattern("bbb", 1)])])).toEqual([]);
  });

  test("sin nada aprendido, el primer lote también cuenta como aprendizaje", () => {
    const { logs } = openContext(":memory:");
    expect(logs.ingest([batch(0, [pattern("aaa", 1)])])).toEqual([]);
  });

  test("pico: 10× la media por hora, con historia suficiente y sin repetir en 6 h", () => {
    const { logs } = openContext(":memory:");
    logs.ingest([batch(0, [pattern("aaa", 5)], { seed: true })]);
    for (let h = 1; h <= 30; h++) logs.ingest([batch(h, [pattern("aaa", 5)])]);
    expect(logs.ingest([batch(31, [pattern("aaa", 20)])])).toEqual([]); // 20 < mínimo 30
    const spike = logs.ingest([batch(31.5, [pattern("aaa", 200)])]);
    expect(spike).toHaveLength(1);
    expect(spike[0]).toMatchObject({ kind: "pico", fp: "aaa", count: 220 });
    expect(spike[0]?.baseline).toBe(5);
    expect(logs.ingest([batch(33, [pattern("aaa", 500)])])).toEqual([]); // en cooldown
  });

  test("un patrón joven no da picos aunque crezca", () => {
    const { logs } = openContext(":memory:");
    logs.ingest([batch(0, [pattern("x", 1)], { seed: true })]);
    logs.ingest([batch(1, [pattern("nuevo", 1)])]);
    expect(logs.ingest([batch(2, [pattern("nuevo", 999)])])).toEqual([]);
  });

  test("los bloqueos de ufw solo avisan si se disparan", () => {
    const { logs } = openContext(":memory:");
    logs.ingest([batch(0, [], { seed: true, ufw_blocks: 100 })]);
    for (let h = 1; h <= 25; h++) expect(logs.ingest([batch(h, [], { ufw_blocks: 100 })])).toEqual([]);
    const a = logs.ingest([batch(26, [], { ufw_blocks: 5000 })]);
    expect(a[0]).toMatchObject({ kind: "pico", fp: UFW_FP });
  });

  test("silenciado no avisa de picos y la vista lo saca de los frecuentes", () => {
    const ctx = openContext(":memory:");
    ctx.logs.ingest([batch(0, [pattern("aaa", 5)], { seed: true })]);
    for (let h = 1; h <= 30; h++) ctx.logs.ingest([batch(h, [pattern("aaa", 5)])]);
    expect(ctx.logs.mute(["aaa", "nope"])).toBe(1);
    expect(ctx.logs.ingest([batch(31, [pattern("aaa", 900)])])).toEqual([]);
    const v = logsView(ctx, 24 * 30);
    expect(v.silenciados.map((p) => p.huella)).toEqual(["aaa"]);
    expect(v.mas_frecuentes).toEqual([]);
  });

  test("el aviso cabe en Discord y el botón no pasa de 100 caracteres", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      kind: "nuevo" as const,
      fp: `abcdef012${i % 10}`,
      unit: "wings.service",
      sample: "x".repeat(500),
      count: 3,
    }));
    const e = anomaliesEmbed(many).toJSON();
    expect(e.fields).toHaveLength(8);
    expect(e.description).toContain("4 más");
    for (const f of e.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(`logs:mute:${many.slice(0, 8).map((a) => a.fp).join(",")}`.length).toBeLessThanOrEqual(100);
  });
});

describe("incidentes", () => {
  test("viene con los incidentes ya vividos y se encuentran sin tildes ni mayúsculas", () => {
    const { incidents } = openContext(":memory:");
    expect(incidents.recent(50).length).toBeGreaterThanOrEqual(9);
    expect(incidents.search("wings se reinicia")[0]?.title).toBe("Wings en bucle de reinicios");
    expect(incidents.search("CUOTA drive")[0]?.title).toContain("cuota");
    expect(incidents.search("la")).toHaveLength(5); // sin palabras útiles: los recientes
  });

  test("apuntar uno pasa por la propuesta con botón y queda buscable", async () => {
    const ctx = openContext(":memory:");
    const proposals: Action[] = [];
    const tools = buildTools(ctx, proposals);
    const out = JSON.parse(
      await callTool(
        tools,
        "proponer_incidente",
        JSON.stringify({
          fecha: "2026-10-30",
          titulo: "Nginx caído por certificado",
          sintoma: "El panel no cargaba",
          causa: "Certificado caducado",
          solucion: "certbot renew y reload de nginx",
        }),
      ),
    );
    expect(out.estado).toContain("NO está apuntado");
    const before = ctx.incidents.recent(100).length;
    const action = proposals[0];
    if (!action) throw new Error("sin propuesta");
    expect(describeAction(action)).toContain("Apuntar incidente");
    const r = await runAction(action, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.incidents.recent(100).length).toBe(before + 1);
    expect(ctx.incidents.search("nginx caído certificado panel")[0]?.title).toBe("Nginx caído por certificado");
  });
});

describe("caducidades", () => {
  const now = Date.parse("2026-11-28T09:00:00Z");
  const snapWithCerts = () => ({
    ...snapshot(new Date(now)),
    certificates: {
      "panel.example.com": { expires_at: "2026-12-17T13:44:47+00:00" },
      "adguard-lan": { expires_at: "2027-01-27T04:07:19+00:00" },
    },
  });

  test("dominios por RDAP, una vez al día, y errores sin romper nada", async () => {
    let calls = 0;
    const ctx = openContext(":memory:", {
      fetchJson: async () => {
        calls++;
        return { events: [{ eventAction: "expiration", eventDate: "2027-10-04T23:59:59.0Z" }] };
      },
    });
    await ctx.expiries.refreshDomains(["example.com"], now);
    await ctx.expiries.refreshDomains(["example.com"], now + 3600_000);
    expect(calls).toBe(1);
    const { items } = ctx.expiries.list(null, now);
    expect(items).toEqual([expect.objectContaining({ what: "Dominio example.com", day: "2027-10-04", kind: "dominio" })]);

    const broken = openContext(":memory:", { fetchJson: async () => Promise.reject(new Error("sin red")) });
    await broken.expiries.refreshDomains(["example.com"], now);
    expect(broken.expiries.list(null, now).errors).toEqual(["dominio example.com: sin red"]);
  });

  test("avisa al cruzar cada umbral una sola vez, sin avalancha de umbrales mayores", () => {
    const { expiries } = openContext(":memory:");
    expiries.addReminder("Renovar Google One", "2026-12-05");
    const first = expiries.due(expiries.list(snapWithCerts(), now).items, now);
    // Cert a 19 días (umbral 20) y Google One a 7 días (umbral 7, sin avisar también del de 30).
    expect(first.map((i) => [i.what, i.threshold])).toEqual([
      ["Renovar Google One", 7],
      ["Certificado panel.example.com", 20],
    ]);
    expect(expiries.due(expiries.list(snapWithCerts(), now).items, now)).toEqual([]);
    const later = now + 6 * 86_400_000;
    expect(expiries.due(expiries.list(snapWithCerts(), later).items, later).map((i) => i.threshold)).toEqual([1]);
  });

  test("un certificado renovado (fecha nueva) vuelve a empezar", () => {
    const { expiries } = openContext(":memory:");
    expiries.due(expiries.list(snapWithCerts(), now).items, now);
    const renewed = {
      ...snapWithCerts(),
      certificates: { "panel.example.com": { expires_at: "2027-03-17T13:44:47+00:00" } },
    };
    expect(expiries.due(expiries.list(renewed, now).items, now)).toEqual([]);
  });

  test("recordatorios desde las herramientas y embed rojo si es inminente", async () => {
    const ctx = openContext(":memory:");
    const tools = buildTools(ctx);
    const out = JSON.parse(await callTool(tools, "recordar_fecha", '{"que":"Cambiar pila CMOS","fecha":"2026-11-02"}'));
    expect(out.hecho).toContain("#1");
    expect(JSON.parse(await callTool(tools, "recordar_fecha", '{"que":"x y z","fecha":"02/11/2026"}')).error).toBe(
      "argumentos inválidos",
    );
    const due = ctx.expiries.due(ctx.expiries.list(null, now).items, now);
    expect(due[0]?.days_left).toBeLessThan(0);
    expect(expiriesEmbed(due).toJSON().description).toContain("caducó hace");
    expect(JSON.parse(await callTool(tools, "borrar_recordatorio", '{"id":1}')).hecho).toContain("borrado");
  });
});

describe("simulacro", () => {
  test("superado, fallido, atrasado o sin hacer", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    const base = snapshot(new Date(now));
    expect(
      simulacroView({ ...base, simulacro: { at: "2026-11-01T09:00:00Z", ok: true, duration_s: 300 } }, now),
    ).toMatchObject({ resultado: "superado", atrasado: false, duracion: "5 min" });
    expect(
      simulacroView({ ...base, simulacro: { at: "2026-09-01T09:00:00Z", ok: false, step: "integridad de anime.db" } }, now),
    ).toMatchObject({ resultado: "FALLIDO en el paso: integridad de anime.db", atrasado: true });
    expect(simulacroView({ ...base, simulacro: { error: "todavía no" } }, now)).toEqual({ error: "todavía no" });
    expect(simulacroView(base, now)).toHaveProperty("error");
  });
});
