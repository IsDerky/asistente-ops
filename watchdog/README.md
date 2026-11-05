# ops-watchdog

Vigilante externo en Cloudflare Workers. El servidor le manda señales
(`ops-ping`); si una deja de llegar más de lo permitido, manda un DM al owner
con el bot de Discord. Avisa también cuando la señal vuelve.

| Señal             | La manda                                  | Avisa tras |
| ----------------- | ----------------------------------------- | ---------- |
| `servidor`        | timer `ops-ping-servidor` cada 5 min      | 15 min     |
| `backup-sistema`  | `server-backup sistema` al acabar bien    | 13 h       |
| `backup-clientes` | `server-backup clientes` al acabar bien   | 30 h       |

Los límites están en `src/checks.ts`. Una señal que nunca ha llegado no avisa.
Mientras siga caída, recuerda cada 24 h.

## Desplegar (una vez)

Wrangler necesita Node ≥ 22 (el de Ubuntu es 18): `nvm install 22` y luego `npx wrangler …`.
Con Bun (`bun --bun x wrangler`) se queda mudo en todo lo que llama a la API.

```bash
npx wrangler login
npx wrangler kv namespace create STATE   # copiar el id a wrangler.jsonc
openssl rand -hex 32                             # token de las señales
npx wrangler secret put PING_TOKEN
npx wrangler secret put DISCORD_BOT_TOKEN   # el de /etc/discord-notify.env
npx wrangler secret put DISCORD_USER_ID
npx wrangler deploy
```

La URL queda en `https://ops-watchdog.<subdominio>.workers.dev`.

## Servidor

Ver `server-scripts/`: `ops-ping`, `ops-ping-servidor.{service,timer}` y la
llamada al final de `server-backup`. Config en `/etc/ops-watchdog.env` (root, 600):

```
OPS_WATCHDOG_URL=https://ops-watchdog.<subdominio>.workers.dev
OPS_WATCHDOG_TOKEN=<el PING_TOKEN>
```

## Comprobar

```bash
curl -H "Authorization: Bearer $TOKEN" https://ops-watchdog.<subdominio>.workers.dev/status
bun test                     # lógica
bash scripts/e2e-local.sh    # punta a punta en local (Node ≥ 22)
```
