import { describe, expect, test } from "bun:test";
import { checkToken, ClaudeSessions, MAX_SESSIONS, projectName, STALE_MS } from "../src/claude";

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const hook = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: "sesion-1",
  cwd: "c:\\Users\\usuario\\proyectos\\mi-app",
  hook_event_name: event,
  ...extra,
});

describe("sesiones de Claude Code", () => {
  test("ciclo de una sesión: empieza, trabaja, pide permiso, termina y se cierra", () => {
    const c = new ClaudeSessions();
    // Solo con SessionStart todavía no hay nadie en la mesa.
    expect(c.hook(hook("SessionStart"), T0)).toEqual([]);
    expect(c.list(T0)).toEqual([]);

    expect(c.hook(hook("UserPromptSubmit", { prompt: "secreto" }), T0 + 1000).map((e) => e.type)).toEqual(["claude.start"]);
    const [s] = c.list(T0);
    expect(s).toMatchObject({ project: "mi-app", state: "working", startedAt: T0 });
    expect(s?.id).toMatch(/^[0-9a-f]{8}$/);

    c.hook(hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf /" } }), T0 + 2000);
    expect(c.list(T0)[0]).toMatchObject({ state: "working", tool: "Bash" });
    expect(JSON.stringify(c.list(T0))).not.toContain("secreto");
    expect(JSON.stringify(c.list(T0))).not.toContain("rm -rf");

    expect(c.hook(hook("PermissionRequest", { tool_name: "Bash" }), T0 + 3000).map((e) => e.type)).toEqual(["claude.needs"]);
    // La notificación de permiso que llega después no repite el aviso.
    expect(c.hook(hook("Notification", { notification_type: "permission_prompt" }), T0 + 3500)).toEqual([]);
    expect(c.list(T0)[0]?.state).toBe("needs_you");

    c.hook(hook("PostToolUse", { tool_name: "Bash" }), T0 + 4000);
    const done = c.hook(hook("Stop"), T0 + 3 * MIN);
    expect(done.map((e) => e.text)).toEqual(["Claude Code ha terminado en mi-app (3 min)"]);
    expect(c.list(T0)[0]?.state).toBe("idle");

    expect(c.hook(hook("SessionEnd"), T0 + 4 * MIN).map((e) => e.type)).toEqual(["claude.end"]);
    expect(c.list(T0)).toEqual([]);
  });

  test("turno corto: sin entrada en el registro; sesión sin SessionStart aparece igual", () => {
    const c = new ClaudeSessions();
    expect(c.hook(hook("UserPromptSubmit"), T0).map((e) => e.type)).toEqual(["claude.start"]);
    expect(c.hook(hook("Stop"), T0 + 20_000)).toEqual([]);
  });

  test("las sesiones vacías que abre y cierra VS Code al arrancar no se pintan ni van al registro", () => {
    const c = new ClaudeSessions();
    for (const id of ["a", "b", "c"]) {
      expect(c.hook({ ...hook("SessionStart"), session_id: id }, T0)).toEqual([]);
      expect(c.list(T0)).toEqual([]);
      expect(c.hook({ ...hook("SessionEnd"), session_id: id }, T0 + 500)).toEqual([]);
    }
    expect(c.list(T0 + 1000)).toEqual([]);
  });

  test("subagentes: cuentan los que trabajan; al acabar el turno no queda ninguno", () => {
    const c = new ClaudeSessions();
    c.hook(hook("UserPromptSubmit"), T0);
    c.hook(hook("SubagentStart"), T0 + 1);
    c.hook(hook("SubagentStart"), T0 + 2);
    expect(c.list(T0)[0]?.subagents).toBe(2);
    c.hook(hook("SubagentStop"), T0 + 3);
    c.hook(hook("SubagentStop"), T0 + 4);
    c.hook(hook("SubagentStop"), T0 + 5);
    expect(c.list(T0)[0]?.subagents).toBe(0);
    c.hook(hook("SubagentStart"), T0 + 6);
    c.hook(hook("Stop"), T0 + 7);
    expect(c.list(T0)[0]).toMatchObject({ subagents: 0, state: "idle" });
  });

  test("minutos trabajados desde medianoche: tramos cerrados, en curso y recortados", () => {
    const c = new ClaudeSessions();
    c.hook(hook("UserPromptSubmit"), T0 - 10 * MIN); // empezó antes de "medianoche" (T0)
    c.hook(hook("Stop"), T0 + 5 * MIN);
    expect(c.workedSince(T0, T0 + 6 * MIN)).toBe(5 * MIN);
    c.hook({ ...hook("UserPromptSubmit"), session_id: "otra" }, T0 + 10 * MIN);
    expect(c.workedSince(T0, T0 + 13 * MIN)).toBe(8 * MIN); // 5 cerrados + 3 en curso
    c.hook({ ...hook("SessionEnd"), session_id: "otra" }, T0 + 20 * MIN);
    expect(c.workedSince(T0, T0 + 30 * MIN)).toBe(15 * MIN);
  });

  test("caducan sin hooks y como mucho se pintan MAX_SESSIONS", () => {
    const c = new ClaudeSessions();
    for (let i = 0; i < MAX_SESSIONS + 2; i++) c.hook({ ...hook("UserPromptSubmit"), session_id: `s${i}` }, T0 + i);
    expect(c.list(T0)).toHaveLength(MAX_SESSIONS);
    expect(c.list(T0 + STALE_MS + 10)).toEqual([]);
  });

  test("payload inválido o sin sesión: nada", () => {
    const c = new ClaudeSessions();
    expect(c.hook({ hook_event_name: "Stop" })).toEqual([]);
    expect(c.hook({ session_id: 3, hook_event_name: "Stop" })).toEqual([]);
    expect(c.list()).toEqual([]);
  });

  test("nombre del proyecto y token", () => {
    expect(projectName("/home/usuario/projects/oficina")).toBe("oficina");
    expect(projectName("C:\\x\\<script>")).toBe("script");
    expect(projectName(undefined)).toBe("?");
    expect(checkToken("Bearer abc", "abc")).toBe(true);
    expect(checkToken("Bearer abd", "abc")).toBe(false);
    expect(checkToken("Bearer abc", "")).toBe(false);
    expect(checkToken(null, "abc")).toBe(false);
  });
});
