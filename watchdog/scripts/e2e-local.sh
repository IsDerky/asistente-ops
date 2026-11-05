#!/bin/bash
# Prueba local de punta a punta: wrangler dev (KV local) + ops-ping real + cron
# simulado. Discord usa un token falso (.dev.vars): el DM falla a propósito y el
# aviso debe quedar pendiente para reintentarse.
#
# Necesita Node >= 22 (wrangler dev no funciona con Bun). En este equipo: Git
# Bash de Windows con `npm install` hecho en Windows, no en WSL.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=8799
URL="http://127.0.0.1:$PORT"
TOKEN=token-de-prueba-local
AUTH="Authorization: Bearer $TOKEN"
OPS_PING="${OPS_PING:-../../server-scripts/ops-ping}"
STATE=$(mktemp -d) # estado nuevo cada vez: uno viejo da falsos avisos
LOG="$STATE/dev.log"

npx wrangler dev --port "$PORT" --test-scheduled --persist-to "$STATE" >"$LOG" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -s -m 3 -o /dev/null "$URL" && break; sleep 1; done

c() { curl -s -m 15 "$@"; }
cron() { c "$URL/__scheduled?cron=*/5+*+*+*+*" >/dev/null; sleep 2; }
attempts() { grep -c 'no enviado' "$LOG"; }

env_file="$STATE/ops-watchdog.env"
printf 'OPS_WATCHDOG_URL=%s\nOPS_WATCHDOG_TOKEN=%s\n' "$URL" "$TOKEN" >"$env_file"

echo "1. sin token            -> $(c -o /dev/null -w '%{http_code}' -X POST "$URL/ping/servidor") (esperado 404)"
echo "2. señal desconocida    -> $(c -o /dev/null -w '%{http_code}' -X POST -H "$AUTH" "$URL/ping/otra") (esperado 400)"
OPS_WATCHDOG_ENV="$env_file" bash "$OPS_PING" servidor
echo "3. ops-ping servidor    -> $(c -H "$AUTH" "$URL/status" | grep -o '"minutesSilent":[0-9]*' | head -1) (esperado 0)"
cron
echo "4. cron en plazo        -> avisos: $(attempts) (esperado 0)"

old=$((($(date +%s) - 7200) * 1000))
npx wrangler kv key put --local --persist-to "$STATE" --binding STATE "last:servidor" "$old" >/dev/null 2>&1
cron
echo "5. 2 h sin señal        -> avisos: $(attempts) (esperado 1; el DM falla)"
echo "   sigue pendiente      -> $(c -H "$AUTH" "$URL/status" | grep -o '"alerting":[a-z]*' | head -1) (esperado false)"
cron
echo "6. siguiente pasada     -> avisos: $(attempts) (esperado 2: reintenta)"
