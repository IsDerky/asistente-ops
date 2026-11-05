// Relé de los hooks de Claude Code a la oficina. Claude Code no deja que los
// hooks "http" llamen a IPs privadas (solo loopback), así que el hook es un
// "command" que reenvía el payload de stdin. claude-hooks.mjs lo copia a
// ~/.claude/oficina-hook.mjs.
//
// No escribe nada en stdout y sale siempre con 0: una salida JSON o un código 2
// podrían bloquear herramientas, y la oficina solo mira.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// La de tu oficina (nginx debería dejar pasar solo a tu PC).
const URL = "https://oficina.example.lan/api/claude/hook";

try {
  const token = readFileSync(join(homedir(), ".claude", "oficina-hook-token"), "utf8").trim();
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: Buffer.concat(chunks),
    // Si el servidor no está, que no frene cada herramienta.
    signal: AbortSignal.timeout(1500),
  });
} catch {}
process.exit(0);
