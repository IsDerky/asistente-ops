#!/bin/bash
# Instala o actualiza el asistente en el servidor. Ejecutar como root desde
# la carpeta del repo:  bash deploy/install.sh
#
# Idempotente: se puede repetir para actualizar. La primera vez crea
# /etc/asistente.env (a partir del ejemplo, o de los secretos que ya haya en
# mi servidor) y solo pide la API key de Groq si aún no está.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
ENV=/etc/asistente.env
BENTO_ENV=/home/bentonime/apps/bentonime/.env.production

[ "$(id -u)" -eq 0 ] || { echo "Ejecutar como root" >&2; exit 1; }
log() { echo "==> $*"; }

log "Usuario opsbot"
id opsbot >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin opsbot

# Bun: el binario se copia junto al código (desde WSL, mismo Linux x64).
if [ -x "$SRC/bun" ]; then
  log "Instalando Bun $("$SRC/bun" --version) en /usr/local/bin"
  install -m 755 "$SRC/bun" /usr/local/bin/bun.new
  mv -f /usr/local/bin/bun.new /usr/local/bin/bun
fi
[ -x /usr/local/bin/bun ] || { echo "Falta Bun: copia el binario como $SRC/bun" >&2; exit 1; }

log "Recolector"
install -m 755 "$SRC/collector/ops-collect" /usr/local/bin/ops-collect.new
mv -f /usr/local/bin/ops-collect.new /usr/local/bin/ops-collect
install -m 644 "$SRC/collector/ops-collect.service" "$SRC/collector/ops-collect.timer" /etc/systemd/system/
install -d -m 750 -o root -g opsbot /var/lib/ops-collect

log "Bot en /opt/asistente"
install -d -m 755 /opt/asistente
rm -rf /opt/asistente/bot.new
mkdir -p /opt/asistente/bot.new
cp -r "$SRC/bot/src" "$SRC/bot/package.json" "$SRC/bot/bun.lock" /opt/asistente/bot.new/
(cd /opt/asistente/bot.new && /usr/local/bin/bun install --production --frozen-lockfile >/dev/null)
chown -R root:root /opt/asistente/bot.new
rm -rf /opt/asistente/bot.old
[ -d /opt/asistente/bot ] && mv /opt/asistente/bot /opt/asistente/bot.old
mv /opt/asistente/bot.new /opt/asistente/bot
install -m 644 "$SRC/deploy/asistente.service" /etc/systemd/system/

log "Permisos de polkit (solo reiniciar bentonime y lanzar el backup de sistema)"
polkit_version=$(pkaction --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)?' | head -1)
if [ -z "$polkit_version" ] || ! awk -v v="$polkit_version" 'BEGIN { exit !(v >= 0.106) }'; then
  echo "polkit ${polkit_version:-?} no admite reglas .rules: las acciones con botones no funcionarán" >&2
fi
install -d -m 755 /etc/polkit-1/rules.d
install -m 644 "$SRC/deploy/50-asistente.rules" /etc/polkit-1/rules.d/50-asistente.rules

if [ ! -f "$ENV" ] && { [ ! -f /etc/discord-notify.env ] || [ ! -f /etc/ops-watchdog.env ]; }; then
  install -m 600 "$SRC/deploy/asistente.env.example" "$ENV"
  echo "He creado $ENV a partir de deploy/asistente.env.example: rellénalo y vuelve a lanzar install.sh" >&2
  exit 1
fi

if [ ! -f "$ENV" ]; then
  log "Creando $ENV con los secretos que ya hay en el servidor"
  # shellcheck source=/dev/null
  . /etc/discord-notify.env
  # shellcheck source=/dev/null
  . /etc/ops-watchdog.env
  ops_token=$(openssl rand -hex 32)
  umask 077
  cat >"$ENV" <<EOF
DISCORD_BOT_TOKEN=$DISCORD_BOT_TOKEN
DISCORD_USER_ID=$DISCORD_USER_ID
OPS_API_TOKEN=$ops_token
BENTONIME_URL=http://127.0.0.1:3939
OPS_WATCHDOG_URL=$OPS_WATCHDOG_URL
OPS_WATCHDOG_TOKEN=$OPS_WATCHDOG_TOKEN
OPS_SNAPSHOT=/var/lib/ops-collect/snapshot.json
ASSISTANT_SUMMARY_HOUR=9
# ASSISTANT_MODEL=openai/gpt-oss-120b   (ver: bun src/cli.ts modelos)
EOF
  if [ -f "$BENTO_ENV" ] && ! grep -q '^OPS_API_TOKEN=' "$BENTO_ENV"; then
    log "Añadiendo OPS_API_TOKEN a Bentonime y reiniciándolo"
    printf '\n# API de solo lectura para el asistente (/api/ops/*)\nOPS_API_TOKEN=%s\n' "$ops_token" >>"$BENTO_ENV"
    systemctl restart bentonime
  fi
fi

# El modelo es de Groq. Si falta su clave (instalación nueva o venida de la
# versión con Anthropic), se pide y se quita lo que quede de Anthropic.
if ! grep -q '^GROQ_API_KEY=.\+' "$ENV" && [ -t 0 ]; then
  read -rsp "API key de Groq (gsk_…): " key
  echo
  if [ -n "$key" ]; then
    sed -i '/^GROQ_API_KEY=/d; /^ANTHROPIC_API_KEY=/d; /^# ASSISTANT_MODEL=claude/d' "$ENV"
    printf 'GROQ_API_KEY=%s\n' "$key" >>"$ENV"
    log "GROQ_API_KEY guardada en $ENV"
  fi
fi

# Pterodactyl (opcional): Application API de SOLO LECTURA. Se pide una vez.
if ! grep -q '^PTERODACTYL_API_KEY=.\+' "$ENV" && [ -t 0 ]; then
  read -rsp "API key de Pterodactyl, solo lectura (ptla_…; Enter para omitir): " pkey
  echo
  if [ -n "$pkey" ]; then
    sed -i '/^PTERODACTYL_API_KEY=/d' "$ENV"
    printf 'PTERODACTYL_API_KEY=%s\n' "$pkey" >>"$ENV"
    log "PTERODACTYL_API_KEY guardada en $ENV"
  fi
fi

# Hooks de Claude Code del PC (la oficina pinta sus sesiones). El token lo
# genera el PC (deploy/claude-hooks.mjs) y viaja en el tar, fuera de git.
if [ -s "$SRC/claude-hook-token" ]; then
  sed -i '/^CLAUDE_HOOK_TOKEN=/d' "$ENV"
  printf 'CLAUDE_HOOK_TOKEN=%s\n' "$(tr -dc 'a-f0-9' <"$SRC/claude-hook-token")" >>"$ENV"
  rm -f "$SRC/claude-hook-token"
  log "CLAUDE_HOOK_TOKEN guardado en $ENV"
fi

systemctl daemon-reload
systemctl enable --now ops-collect.timer
systemctl start ops-collect.service
log "Snapshot: $(stat -c '%s bytes, %y' /var/lib/ops-collect/snapshot.json)"

if grep -q '^GROQ_API_KEY=.\+' "$ENV"; then
  systemctl enable asistente >/dev/null 2>&1
  systemctl restart asistente
  sleep 5
  systemctl --no-pager status asistente | tail -5
else
  echo "Falta GROQ_API_KEY en $ENV: añádela y ejecuta  systemctl enable --now asistente"
fi
