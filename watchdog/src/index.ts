/**
 * Vigilante externo: vive en Cloudflare, fuera del servidor, para enterarse
 * justo cuando el servidor no puede avisar (apagado, sin red, backups parados).
 *
 *   POST /ping/<señal>   el servidor avisa de que sigue vivo / acabó un backup
 *   GET  /status         estado de todas las señales (JSON)
 *
 * Ambas exigen `Authorization: Bearer <PING_TOKEN>`. Un cron cada 5 min revisa
 * las señales y manda un DM al owner con el bot de Discord.
 */
import { CHECKS } from "./checks";
import { alertEmbed, sendDm } from "./discord";
import { type Alert, markAlerted, recordPing, status, sweep } from "./watchdog";

interface Env {
  STATE: KVNamespace;
  PING_TOKEN: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_USER_ID: string;
}

async function authorized(req: Request, token: string): Promise<boolean> {
  const header = req.headers.get("Authorization") ?? "";
  const given = new TextEncoder().encode(header);
  const expected = new TextEncoder().encode(`Bearer ${token}`);
  // Comparar resúmenes de igual tamaño evita filtrar el token por tiempos.
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", given),
    crypto.subtle.digest("SHA-256", expected),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function notify(env: Env, alerts: Alert[], now: number): Promise<void> {
  for (const alert of alerts) {
    try {
      await sendDm(env.DISCORD_BOT_TOKEN, env.DISCORD_USER_ID, alertEmbed(alert, now));
      await markAlerted(env.STATE, alert, now);
    } catch (err) {
      // Sin marcar: la próxima pasada del cron lo reintenta.
      console.error(`aviso ${alert.kind} de ${alert.name} no enviado`, err);
    }
  }
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    if (!env.PING_TOKEN || !(await authorized(req, env.PING_TOKEN))) {
      return new Response("Not found", { status: 404 });
    }
    const now = Date.now();

    const ping = url.pathname.match(/^\/ping\/([a-z0-9-]+)$/);
    if (ping && req.method === "POST") {
      const name = ping[1] ?? "";
      if (!CHECKS[name]) return new Response("Señal desconocida", { status: 400 });
      const recovered = await recordPing(env.STATE, name, now);
      if (recovered) ctx.waitUntil(notify(env, [recovered], now));
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/status" && req.method === "GET") {
      return Response.json(await status(env.STATE, now));
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event, env, _ctx): Promise<void> {
    const now = Date.now();
    await notify(env, await sweep(env.STATE, now), now);
  },
} satisfies ExportedHandler<Env>;
