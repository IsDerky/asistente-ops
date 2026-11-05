import { checkToken, type HookPayload } from "./claude";
import { config } from "./config";
import type { Ctx } from "./context";
import { isError, readSnapshot } from "./data";
import { type OfficeState, officeState } from "./office";

/**
 * API para la oficina, solo en 127.0.0.1 (nginx la publica únicamente en la
 * LAN). Solo lectura, sin botones. Nada de aquí ejecuta acciones.
 *
 *   GET /api/state           personajes, bandeja, servidor, racks y sesiones de Claude Code
 *   GET /api/honeypot?horas  ataques: tipos, países, credenciales, feed…
 *   GET /api/events          SSE: "state" cada 15 s, "event" y "claude" al momento
 *   POST /api/claude/hook    hooks de Claude Code del PC (token; nginx solo deja al PC)
 */

type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();

/** Avisa a las oficinas abiertas (anomalías, ataques nuevos…). */
export function broadcast(event: string, data: unknown) {
  for (const l of listeners) l(event, data);
}

const STATE_EVERY_MS = 15_000;

/**
 * El estado consulta Bentonime y el vigilante (Cloudflare): se calcula como
 * mucho una vez cada 10 s aunque haya varias oficinas abiertas.
 */
let cached: { at: number; value: Promise<OfficeState> } | null = null;
function sharedState(ctx: Ctx): Promise<OfficeState> {
  if (!cached || Date.now() - cached.at > 10_000) {
    cached = { at: Date.now(), value: officeState(ctx) };
    cached.value.catch(() => {
      cached = null;
    });
  }
  return cached.value;
}

export function startApi(ctx: Ctx, port = config.apiPort) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0, // SSE: conexiones largas
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/api/claude/hook") return claudeHook(ctx, req);
      if (req.method !== "GET") return new Response("Solo lectura", { status: 405 });
      try {
        switch (url.pathname) {
          case "/api/health":
            return Response.json({ ok: true });
          case "/api/state":
            return Response.json(await sharedState(ctx));
          case "/api/honeypot": {
            const hours = Math.min(Math.max(Number(url.searchParams.get("horas") ?? 24) || 24, 1), 24 * 30);
            return Response.json({ ...ctx.attacks.summary(hours), baneadas: await banned() });
          }
          case "/api/office/events": {
            const limit = Math.min(Math.max(Number(url.searchParams.get("limite") ?? 60) || 60, 1), 200);
            return Response.json(ctx.events.recent(limit));
          }
          case "/api/honeypot/ip": {
            const ip = url.searchParams.get("ip") ?? "";
            if (!/^[0-9a-fA-F.:]{3,45}$/.test(ip)) return Response.json({ error: "IP no válida" }, { status: 400 });
            const detail = ctx.attacks.ipDetail(ip);
            if (!detail) return Response.json({ error: "no se ha visto esa IP" }, { status: 404 });
            const jails = Object.entries(await banned())
              .filter(([, ips]) => ips.includes(ip))
              .map(([jail]) => jail);
            return Response.json({ ...detail, baneada_en: jails });
          }
          case "/api/events":
            return events(ctx, req.signal);
          default:
            return new Response("No existe", { status: 404 });
        }
      } catch (err) {
        console.error("API de la oficina:", err);
        return Response.json({ error: (err as Error).message }, { status: 500 });
      }
    },
  });
}

/**
 * Hook de Claude Code. Siempre 204 sin cuerpo: una respuesta con JSON podría
 * entenderse como una decisión (bloquear una herramienta, denegar un permiso).
 */
async function claudeHook(ctx: Ctx, req: Request): Promise<Response> {
  if (!checkToken(req.headers.get("authorization"), config.claudeHookToken)) {
    return new Response(null, { status: 401 });
  }
  let payload: HookPayload;
  try {
    payload = (await req.json()) as HookPayload;
  } catch {
    return new Response(null, { status: 400 });
  }
  for (const e of ctx.claude.hook(payload)) ctx.events.push(e);
  cached = null; // el próximo /api/state ya trae la sesión al día
  broadcast("claude", ctx.claude.list());
  return new Response(null, { status: 204 });
}

/** IPs baneadas ahora por jail de fail2ban (del snapshot; {} si no hay datos). */
async function banned(): Promise<Record<string, string[]>> {
  const snap = await readSnapshot();
  if (isError(snap) || !snap.fail2ban || isError(snap.fail2ban)) return {};
  return Object.fromEntries(Object.entries(snap.fail2ban).map(([jail, j]) => [jail, j.banned]));
}

function events(ctx: Ctx, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let listener: Listener | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // la oficina se ha cerrado
        }
      };
      const sendState = () => sharedState(ctx).then((s) => send("state", s)).catch(() => {});
      listener = send;
      listeners.add(listener);
      await sendState();
      timer = setInterval(sendState, STATE_EVERY_MS);
      signal.addEventListener("abort", () => {
        if (timer) clearInterval(timer);
        if (listener) listeners.delete(listener);
        try {
          controller.close();
        } catch {
          // ya cerrado
        }
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
      if (listener) listeners.delete(listener);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
}
