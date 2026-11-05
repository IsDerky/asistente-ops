// Pone (o quita) en el PC los hooks de Claude Code que avisan a la oficina de
// las sesiones abiertas (vía el relé oficina-hook.mjs, que se copia a ~/.claude). Se ejecuta en Windows con Node:
//
//   node deploy/claude-hooks.mjs --token <ruta>   crea el token (si no hay) y lo copia a <ruta>; no toca los hooks
//   node deploy/claude-hooks.mjs                  pone los hooks (después de desplegar el asistente y la oficina)
//   node deploy/claude-hooks.mjs --quitar         los quita
//
// Fusiona con ~/.claude/settings.json sin tocar los demás hooks. El token se
// guarda en ~/.claude/oficina-hook-token, no se imprime y lo lee el relé; viaja al servidor en
// el tar del asistente (deploy/install.sh lo pasa a /etc/asistente.env).
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Notification solo para los permisos; el resto, todos.
const EVENTS = {
  SessionStart: "",
  UserPromptSubmit: null,
  PreToolUse: "",
  PostToolUse: "",
  PostToolUseFailure: "",
  PermissionRequest: "",
  Notification: "permission_prompt",
  Stop: null,
  SubagentStart: "",
  SubagentStop: "",
  SessionEnd: "",
};

const dir = join(homedir(), ".claude");
const settingsPath = join(dir, "settings.json");
const tokenPath = join(dir, "oficina-hook-token");
const relayPath = join(dir, "oficina-hook.mjs");
const COMMAND = `node "${relayPath}"`;
const args = process.argv.slice(2);
const remove = args.includes("--quitar");

function ensureToken() {
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  return readFileSync(tokenPath, "utf8").trim();
}

const t = args.indexOf("--token");
if (t >= 0) {
  if (!args[t + 1]) throw new Error("Falta la ruta: --token <ruta>");
  ensureToken();
  copyFileSync(tokenPath, args[t + 1]);
  console.log(`Token copiado a ${args[t + 1]} (no se ha tocado settings.json).`);
  process.exit(0);
}

const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
const hooks = (settings.hooks ??= {});
const ours = (group) => group.hooks?.some((h) => h.type === "command" && h.command === COMMAND);

for (const event of Object.keys(EVENTS)) {
  const groups = (hooks[event] ?? []).filter((g) => !ours(g));
  if (groups.length) hooks[event] = groups;
  else delete hooks[event];
}

if (!remove) {
  ensureToken();
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "oficina-hook.mjs"), relayPath);
  for (const [event, matcher] of Object.entries(EVENTS)) {
    // El relé corta a 1,5 s; esto es solo la red de seguridad.
    const group = { hooks: [{ type: "command", command: COMMAND, timeout: 3 }] };
    if (matcher != null) group.matcher = matcher;
    (hooks[event] ??= []).push(group);
  }
}

if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak`);
writeFileSync(`${settingsPath}.tmp`, `${JSON.stringify(settings, null, 2)}\n`);
renameSync(`${settingsPath}.tmp`, settingsPath);
console.log(remove ? "Hooks de la oficina quitados." : `Hooks de la oficina puestos en ${Object.keys(EVENTS).length} eventos.`);
console.log(`Copia anterior: ${settingsPath}.bak`);
