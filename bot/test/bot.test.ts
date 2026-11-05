import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType } from "discord.js";
import Groq from "groq-sdk";
import { z } from "zod";
import {
  type Action,
  compact,
  describeAction,
  PendingActions,
  PROPOSAL_TTL_MS,
} from "../src/actions";
import { announcesProposal, ask, type Complete, runWithTools, toGroqTools } from "../src/agent";
import { config } from "../src/config";
import { openContext } from "../src/context";
import { isError, readSnapshot } from "../src/data";
import { errorText, isOwnerDm } from "../src/discord";
import { COLORS, proposalEmbed, summaryEmbeds, textEmbeds } from "../src/embeds";
import { chunks } from "../src/format";
import { History } from "../src/history";
import { buildTools, callTool, type Tool } from "../src/tools";
import { dailyTrigger, madridClock } from "../src/schedule";
import { backupsView, containersView, systemView } from "../src/views";
import { snapshot } from "./fixtures";

const MIN = 60_000;

describe("histórico", () => {
  test("guarda una vez por snapshot y da el pico de RAM con su hora", () => {
    const h = new History(":memory:");
    const now = Date.now();
    expect(h.record(snapshot(new Date(now - 60 * MIN), 6))).toBe(2);
    expect(h.record(snapshot(new Date(now - 30 * MIN), 9))).toBe(2);
    expect(h.record(snapshot(new Date(now - 30 * MIN), 9))).toBe(0); // repetido
    h.record(snapshot(new Date(now - 5 * MIN), 7));
    const mc = h.peaks(now - 2 * 3600_000).find((p) => p.container === "uuid-mc");
    expect(mc?.peak_mem_bytes).toBe(9 * 1024 ** 3);
    expect(mc?.peak_at).toBe(now - 30 * MIN);
    expect(mc?.samples).toBe(3);
  });

  test("la ventana deja fuera lo antiguo", () => {
    const h = new History(":memory:");
    const now = Date.now();
    h.record(snapshot(new Date(now - 30 * 3600_000), 15));
    h.record(snapshot(new Date(now - MIN), 5));
    const mc = h.peaks(now - 24 * 3600_000).find((p) => p.container === "uuid-mc");
    expect(mc?.peak_mem_bytes).toBe(5 * 1024 ** 3);
  });
});

describe("vistas", () => {
  test("sistema en formato legible y servicios caídos visibles", () => {
    const v = systemView(snapshot(new Date()));
    expect(v.ram).toBe("9.0 GB de 38 GB (24 %)");
    expect(v.discos["/"]).toContain("50 %");
    expect(v.servicios).toMatchObject({
      bentonime: "active / running",
      wings: "failed / failed / 3 reinicios",
    });
  });

  test("backups: con datos, y sin ejecuciones desde el arranque", () => {
    const v = backupsView(snapshot(new Date())) as Record<string, unknown>;
    expect(v.sistema).toMatchObject({ estado: "success", duracion: "5 min" });
    expect(v.clientes).toBe("sin ejecuciones desde el último arranque del servidor");
  });

  test("clientes ordenados por RAM, con nombre del panel o aviso si no es del panel", () => {
    const h = new History(":memory:");
    const snap = snapshot(new Date());
    h.record(snap);
    const v = containersView(snap, h, 24) as { contenedores: Array<Record<string, string>> };
    expect(v.contenedores[0]?.servidor).toBe("Survival de Pepe");
    expect(v.contenedores[1]?.servidor).toContain("no es un servidor del panel");
  });
});

describe("snapshot", () => {
  test("uno viejo cuenta como error (recolector parado)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "asis-"));
    const path = join(dir, "snapshot.json");
    writeFileSync(path, JSON.stringify(snapshot(new Date(Date.now() - 40 * MIN))));
    const r = await readSnapshot(path);
    expect(isError(r) && r.error).toContain("no actualiza desde hace 40 min");
  });

  test("si no existe, error en vez de excepción", async () => {
    expect(isError(await readSnapshot("/no/existe.json"))).toBe(true);
  });
});

describe("resumen diario", () => {
  test("las 9:00 de Madrid en invierno y en verano", () => {
    expect(madridClock(new Date("2026-10-29T08:00:00Z")).hour).toBe(9); // CET, UTC+1
    expect(madridClock(new Date("2026-07-01T07:00:00Z")).hour).toBe(9); // CEST, UTC+2
  });

  test("toca una sola vez al día, a la hora pedida", () => {
    const due = dailyTrigger(9, new Date("2026-10-29T06:00:00Z")); // 07:00 Madrid
    expect(due(new Date("2026-10-29T07:59:00Z"))).toBe(false); // 08:59
    expect(due(new Date("2026-10-29T08:00:00Z"))).toBe(true); // 09:00
    expect(due(new Date("2026-10-29T08:01:00Z"))).toBe(false); // ya enviado hoy
    expect(due(new Date("2026-10-30T08:00:00Z"))).toBe(true); // al día siguiente
  });

  test("el día del cambio de hora también toca a las 9:00 locales", () => {
    // 2026-10-25: a las 03:00 CEST vuelven a ser las 02:00 CET.
    const due = dailyTrigger(9, new Date("2026-10-24T20:00:00Z"));
    expect(due(new Date("2026-10-25T07:00:00Z"))).toBe(false); // 08:00 CET
    expect(due(new Date("2026-10-25T08:00:00Z"))).toBe(true); // 09:00 CET
  });

  test("si arranca después de la hora, ese día no lo repite", () => {
    const due = dailyTrigger(9, new Date("2026-10-29T10:30:00Z")); // 11:30 Madrid
    expect(due(new Date("2026-10-29T10:31:00Z"))).toBe(false);
    expect(due(new Date("2026-10-30T08:00:00Z"))).toBe(true);
  });
});

describe("quién puede hablarle", () => {
  const OWNER = "100000000000000001";
  const msg = (over: { id?: string; bot?: boolean; guildId?: string | null; type?: ChannelType }) => ({
    author: { id: over.id ?? OWNER, bot: over.bot ?? false },
    guildId: over.guildId ?? null,
    channel: { type: over.type ?? ChannelType.DM },
  });

  test("el owner por DM, sí", () => {
    expect(isOwnerDm(msg({}), OWNER)).toBe(true);
  });
  test("otra persona por DM, no", () => {
    expect(isOwnerDm(msg({ id: "123456789012345678" }), OWNER)).toBe(false);
  });
  test("el owner en un canal de servidor, no", () => {
    expect(isOwnerDm(msg({ guildId: "999", type: ChannelType.GuildText }), OWNER)).toBe(false);
  });
  test("un DM de grupo, no", () => {
    expect(isOwnerDm(msg({ type: ChannelType.GroupDM }), OWNER)).toBe(false);
  });
  test("otro bot, no", () => {
    expect(isOwnerDm(msg({ bot: true }), OWNER)).toBe(false);
  });

  test("un DISCORD_USER_ID distinto en el .env hace fallar el arranque", () => {
    const prev = process.env.DISCORD_USER_ID;
    process.env.DISCORD_USER_ID = "123";
    expect(() => config.ownerId(OWNER)).toThrow("no coincide");
    process.env.DISCORD_USER_ID = OWNER;
    expect(config.ownerId(OWNER)).toBe(OWNER);
    if (prev === undefined) delete process.env.DISCORD_USER_ID;
    else process.env.DISCORD_USER_ID = prev;
  });

  test("sin un ID real en el código no arranca", () => {
    expect(() => config.ownerId()).toThrow("OWNER_DISCORD_ID");
  });
});

describe("errores de la API", () => {
  test("el DM explica el motivo de un 400", () => {
    const err = new Groq.BadRequestError(
      400,
      { error: { message: "model `x` does not exist", type: "invalid_request_error" } },
      "400 …",
      new Headers(),
    );
    expect(errorText(err)).toBe("⚠️ Error de la API de Groq (400): model `x` does not exist");
  });

  test("el límite del plan gratuito se explica como tal", () => {
    const err = new Groq.RateLimitError(
      429,
      { error: { message: "Rate limit reached", type: "tokens" } },
      "429 …",
      new Headers(),
    );
    expect(errorText(err)).toContain("plan gratuito");
  });
});

describe("bucle de herramientas", () => {
  type Params = Parameters<Complete>[0];
  const reply = (message: Record<string, unknown>, finish = "stop") =>
    ({ choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", ...message } }] }) as never;
  const toolCall = (id: string, name: string, args: string) => ({
    id,
    type: "function",
    function: { name, arguments: args },
  });
  const echo: Tool = {
    name: "eco",
    description: "devuelve lo que recibe",
    schema: z.object({ horas: z.number().int().max(24).optional() }),
    run: async (input) => JSON.stringify({ visto: input }),
  };

  test("ejecuta la herramienta, le devuelve el resultado y responde", async () => {
    const seen: Params[] = [];
    const complete: Complete = async (p) => {
      seen.push(structuredClone(p));
      return seen.length === 1
        ? reply({ content: null, tool_calls: [toolCall("c1", "eco", '{"horas":6}')] })
        : reply({ content: "Todo bien" });
    };
    const answer = await runWithTools([{ role: "user", content: "¿qué tal?" }], [echo], "low", complete);
    expect(answer).toBe("Todo bien");
    const toolMsg = seen[1]?.messages.at(-1) as { role: string; tool_call_id: string; content: string };
    expect(toolMsg).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(JSON.parse(toolMsg.content)).toEqual({ visto: { horas: 6 } });
  });

  test("argumentos inválidos vuelven al modelo como error, sin ejecutar nada", async () => {
    let ran = false;
    const t: Tool = { ...echo, run: async () => ((ran = true), "x") };
    let second: Params | undefined;
    const complete: Complete = async (p) => {
      if (!second && p.messages.length > 1) {
        second = p;
        return reply({ content: "vale" });
      }
      return reply({ content: null, tool_calls: [toolCall("c1", "eco", '{"horas":500}')] });
    };
    await runWithTools([{ role: "user", content: "x" }], [t], "low", complete);
    expect(ran).toBe(false);
    const last = second?.messages.at(-1) as { content: string };
    expect(JSON.parse(last.content).error).toBe("argumentos inválidos");
  });

  test("herramienta inexistente o JSON roto: error para el modelo, no excepción", async () => {
    expect(JSON.parse(await callTool([echo], "otra", "{}")).error).toContain("no existe");
    expect(JSON.parse(await callTool([echo], "eco", "{roto")).error).toContain("JSON");
  });

  test("no se queda en bucle infinito", async () => {
    let calls = 0;
    const complete: Complete = async () => {
      calls++;
      return reply({ content: null, tool_calls: [toolCall(`c${calls}`, "eco", "{}")] });
    };
    const answer = await runWithTools([{ role: "user", content: "x" }], [echo], "low", complete);
    expect(calls).toBe(8);
    expect(answer).toContain("demasiadas vueltas");
  });

  test("los esquemas que recibe Groq no llevan $schema y tienen las propiedades", () => {
    const [t] = toGroqTools([echo]);
    expect(t?.function?.parameters).not.toHaveProperty("$schema");
    expect(t?.function?.parameters).toMatchObject({
      type: "object",
      properties: { horas: { type: "integer" } },
    });
  });
});

describe("acciones con confirmación", () => {
  test("una propuesta se usa una sola vez (doble clic no repite)", () => {
    const p = new PendingActions();
    const id = p.add({ kind: "reiniciar_bentonime" });
    expect(p.take(id)).toEqual({ kind: "reiniciar_bentonime" });
    expect(p.take(id)).toBeNull();
  });

  test("caduca a los 10 minutos", () => {
    const p = new PendingActions();
    const t0 = 1_000_000;
    const id = p.add({ kind: "backup_sistema" }, t0);
    expect(p.take(id, t0 + PROPOSAL_TTL_MS + 1)).toBeNull();
    const id2 = p.add({ kind: "backup_sistema" }, t0);
    expect(p.take(id2, t0 + PROPOSAL_TTL_MS - 1)).toEqual({ kind: "backup_sistema" });
  });

  test("un id inventado no ejecuta nada", () => {
    expect(new PendingActions().take("deadbeef0000")).toBeNull();
  });

  test("descripción legible con rangos de episodios", () => {
    expect(compact([5, 1, 2, 3, 9])).toBe("1-3, 5, 9");
    expect(
      describeAction({ kind: "encolar_episodios", slug: "f", title: "Frieren", episodes: [1, 2, 3, 5] }),
    ).toBe("📥 Encolar en Bentonime: Frieren, Episodios 1-3, 5 (4)");
  });

  test("proponer_accion no ejecuta: solo deja la propuesta", async () => {
    const proposals: Action[] = [];
    const tools = buildTools(openContext(":memory:"), proposals);
    const out = JSON.parse(await callTool(tools, "proponer_accion", '{"accion":"reiniciar_bentonime"}'));
    expect(out.estado).toContain("NO está hecha");
    expect(proposals).toEqual([{ kind: "reiniciar_bentonime" }]);
  });

  test("encolar sin slug o con una acción fuera de la lista: error, sin propuesta", async () => {
    const proposals: Action[] = [];
    const tools = buildTools(openContext(":memory:"), proposals);
    const noSlug = JSON.parse(await callTool(tools, "proponer_accion", '{"accion":"encolar_episodios"}'));
    expect(noSlug.error).toContain("slug");
    const other = JSON.parse(await callTool(tools, "proponer_accion", '{"accion":"reiniciar_wings"}'));
    expect(other.error).toBe("argumentos inválidos");
    expect(proposals).toEqual([]);
  });

  test("si anuncia una propuesta sin hacerla, se le da una oportunidad y la hace", async () => {
    let n = 0;
    const msg = (content: string | null, tool_calls?: unknown[]) =>
      ({
        choices: [
          { index: 0, finish_reason: tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content, tool_calls } },
        ],
      }) as never;
    const complete: Complete = async () => {
      n++;
      if (n === 1) return msg("Voy a proponer la acción de lanzar el backup (faltará tu confirmación).");
      if (n === 2)
        return msg(null, [
          { id: "c1", type: "function", function: { name: "proponer_accion", arguments: '{"accion":"backup_sistema"}' } },
        ]);
      return msg("Propuesto, falta que lo confirmes.");
    };
    const r = await ask(openContext(":memory:"), [], "lanza el backup", complete);
    expect(r.proposals).toEqual([{ kind: "backup_sistema" }]);
    expect(r.answer).toBe("Propuesto, falta que lo confirmes.");
  });

  test("una respuesta normal no dispara el reintento", async () => {
    let n = 0;
    const complete: Complete = async () => {
      n++;
      return {
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Todo bien: RAM al 22 %." } }],
      } as never;
    };
    await ask(openContext(":memory:"), [], "¿qué tal?", complete);
    expect(n).toBe(1);
    expect(announcesProposal("Te propongo reiniciar")).toBe(true);
    expect(announcesProposal("El disco está al 43 %")).toBe(false);
  });

  test("ask devuelve las propuestas que hizo el modelo", async () => {
    let n = 0;
    const complete: Complete = async () =>
      (++n === 1
        ? {
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: { name: "proponer_accion", arguments: '{"accion":"backup_sistema"}' },
                    },
                  ],
                },
              },
            ],
          }
        : {
            choices: [
              { index: 0, finish_reason: "stop", message: { role: "assistant", content: "Te lo propongo." } },
            ],
          }) as never;
    const r = await ask(openContext(":memory:"), [], "lanza el backup", complete);
    expect(r.answer).toBe("Te lo propongo.");
    expect(r.proposals).toEqual([{ kind: "backup_sistema" }]);
  });
});

describe("embeds", () => {
  test("resumen verde si todo va bien, ámbar si hay avisos", () => {
    const now = new Date("2026-10-29T08:00:00Z");
    const ok = summaryEmbeds("Todo en orden\n- Backups bien", now)[0]?.[0]?.toJSON();
    expect(ok?.color).toBe(COLORS.green);
    expect(ok?.title).toBe("☀️ Resumen de la mañana · jue, 29 oct");
    const warn = summaryEmbeds("⚠️ Wings caído\n- …", now)[0]?.[0]?.toJSON();
    expect(warn?.color).toBe(COLORS.amber);
  });

  test("un texto largo se reparte respetando los límites de Discord", () => {
    const text = Array.from({ length: 400 }, (_, i) => `línea ${i} ${"x".repeat(60)}`).join("\n");
    const messages = textEmbeds(text);
    for (const embeds of messages) {
      expect(embeds.length).toBeLessThanOrEqual(10);
      const total = embeds.reduce((n, e) => n + (e.toJSON().description?.length ?? 0), 0);
      expect(total).toBeLessThanOrEqual(6000);
      for (const e of embeds) expect(e.toJSON().description?.length ?? 0).toBeLessThanOrEqual(4096);
    }
    const all = messages.flat().map((e) => e.toJSON().description).join("\n");
    expect(all).toBe(text);
    // Solo el último lleva pie.
    const flat = messages.flat();
    expect(flat.at(-1)?.toJSON().footer).toBeDefined();
    expect(flat[0]?.toJSON().footer).toBeUndefined();
  });

  test("la propuesta cambia de color según su estado", () => {
    const a: Action = { kind: "reiniciar_bentonime" };
    expect(proposalEmbed(a, { state: "pending" }).toJSON().color).toBe(COLORS.blue);
    expect(proposalEmbed(a, { state: "running" }).toJSON().color).toBe(COLORS.amber);
    expect(proposalEmbed(a, { state: "done", ok: true, result: "✅" }).toJSON().color).toBe(COLORS.green);
    expect(proposalEmbed(a, { state: "done", ok: false, result: "⚠️" }).toJSON().color).toBe(COLORS.red);
    expect(proposalEmbed(a, { state: "cancelled" }).toJSON().color).toBe(COLORS.grey);
  });
});

describe("mensajes de Discord", () => {
  test("trocea por líneas sin pasar de 1900 caracteres", () => {
    const text = Array.from({ length: 100 }, (_, i) => `línea ${i} ${"x".repeat(40)}`).join("\n");
    const parts = chunks(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1900)).toBe(true);
    expect(parts.join("\n")).toBe(text);
  });
});
