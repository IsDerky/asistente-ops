import Groq from "groq-sdk";
import type { ChatCompletionCreateParamsNonStreaming } from "groq-sdk/resources/chat/completions";
import { z } from "zod";
import type { Action } from "./actions";
import { config, type Effort } from "./config";
import type { Ctx } from "./context";
import { madrid } from "./format";
import { buildTools, callTool, type Tool } from "./tools";
import { fullReport } from "./views";

/**
 * El cerebro del asistente, con Groq. Dos usos:
 *  - ask(): preguntas por DM, con herramientas de solo lectura (bucle propio).
 *  - dailySummary(): una sola llamada con todos los datos ya recogidos.
 */
const SYSTEM = `Eres el asistente de operaciones del servidor casero de Alex. Hablas en español de España, en tono directo y cercano, y respondes por mensaje directo de Discord.

El servidor es un Dell OptiPlex (i5-8500, 38 GB de RAM, un SSD de 256 GB, Ubuntu 24.04). Aloja:
- Bentonime: la app de anime de Alex (Next.js en systemd, puerto 3939, expuesta por un túnel de Cloudflare).
- Pterodactyl: panel, Wings y servidores de juego de CLIENTES que le pagan. De ellos solo se miran métricas desde el host. Nunca propongas entrar en sus servidores, ejecutar comandos dentro, ni pararlos, arrancarlos o borrarlos.
- Backups con restic a Google Drive (sistema cada 6 h, clientes a diario, mantenimiento los domingos) y un vigilante externo en Cloudflare que avisa si el servidor o los backups dejan de dar señales.
- AdGuard Home (DNS del PC de Alex), nginx, cloudflared y code-server.
- Un honeypot (Cowrie: SSH y Telnet falsos en un contenedor aislado). Lo que pasa ahí no afecta al servidor real; los intentos contra el SFTP de Wings y las sondas a nginx son ataques reales que no han pasado.

Cómo responder:
- Usa las herramientas para mirar los datos reales antes de afirmar nada. Nunca inventes cifras, nombres ni horas: si un dato no aparece en lo que devuelven las herramientas, di que no lo tienes. Si una fuente devuelve un error, dilo tal cual y responde con lo demás.
- Sé breve: Discord en el móvil. Ve al grano, con listas cortas si ayudan. Sin tablas (Discord no las muestra) ni encabezados grandes.
- Si algo pinta mal (servicio caído, backup fallido, disco o RAM al límite, SMART raro), dilo primero y sugiere el siguiente paso concreto (por ejemplo, el comando de journalctl que miraría).
- Antes de diagnosticar un problema, busca en la memoria de incidentes (buscar_incidentes): si ya pasó, di cuándo y qué lo arregló. Para errores en logs, mira la herramienta logs.
- Cuando se resuelva un problema nuevo, ofrece apuntarlo; si Alex dice que sí, usa proponer_incidente (él lo confirma con un botón).
- Fechas que Alex quiera recordar (renovaciones, cambiar la pila…): recordar_fecha. Para ver qué caduca: caducidades.
- Acciones: solo puedes PROPONERLAS con la herramienta proponer_accion (reiniciar Bentonime, lanzar el backup de sistema, encolar episodios en Bentonime). Alex las confirma con un botón; tú nunca las ejecutas.
  - Cuando Alex pida una acción, LLAMA a proponer_accion en ese mismo turno. No anuncies que la vas a proponer: proponla. Después di en una frase qué has propuesto y que falta su confirmación; nunca digas que ya está hecho.
  - Propón solo lo que Alex haya pedido.
  - Para encolar: busca el anime con buscar_anime. Si salen varias temporadas o versiones y Alex no ha dicho cuál, NO propongas nada: enumera las opciones y pregunta cuál. Si está claro, mira sus episodios con episodios_anime para usar el slug exacto.
  - Cualquier otra acción (otros servicios, servidores de clientes…) no está disponible: dilo y sugiere el comando.
- Las horas, en hora de Madrid.`;

const SUMMARY_TASK = `Redacta el resumen de la mañana a partir de este informe (JSON).

Formato: empieza con una línea de veredicto ("Todo en orden" o qué requiere atención). Después, solo lo que aporte, en bloques cortos:
- Problemas o avisos, si los hay (primero).
- Backups: si se hicieron y cuándo. El simulacro de restauración solo si falló o está atrasado.
- Caducidades: lo que caduca en 30 días o menos, con los días que faltan; si no hay nada, no lo menciones.
- Ataques: una sola línea (intentos, IPs y países principales); destaca solo si el honeypot cazó descargas.
- Bentonime: episodios nuevos de lo que Alex sigue (y si ya están descargados); descargas fallidas o crons con error.
- Clientes: el servidor con más RAM y su pico de las últimas 24 h.
- Servidor: disco, RAM y SMART en una línea si todo está bien.
No repitas datos sin interés ni enumeres todos los servicios si están bien. Usa solo datos del informe. Máximo unas 15 líneas.`;

/** Turnos de conversación que se guardan entre preguntas (solo texto). */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

type Message = Groq.Chat.ChatCompletionMessageParam;
type Completion = Groq.Chat.ChatCompletion;
export type Complete = (params: ChatCompletionCreateParamsNonStreaming) => Promise<Completion>;

const MAX_TOOL_ROUNDS = 8;

let groq: Groq | null = null;
const defaultComplete: Complete = (params) => {
  groq ??= new Groq({ apiKey: config.groqApiKey() });
  return groq.chat.completions.create(params);
};

/**
 * `reasoning_effort` con low/medium/high es de los gpt-oss; otros modelos que
 * razonan (Qwen) solo aceptan none/default, así que a esos no se les manda.
 */
function reasoning(effort: Effort) {
  return /gpt-oss/i.test(config.model) ? { reasoning_effort: effort } : {};
}

export function toGroqTools(tools: Tool[]): Groq.Chat.ChatCompletionTool[] {
  return tools.map((t) => {
    // Sin "$schema": algunos proveedores compatibles con OpenAI lo rechazan.
    const { $schema: _, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return {
      type: "function",
      function: { name: t.name, description: t.description, parameters },
    };
  });
}

function finalText(completion: Completion): string {
  const choice = completion.choices[0];
  const text = choice?.message.content?.trim() ?? "";
  if (choice?.finish_reason === "length") return `${text}\n\n_(respuesta cortada por longitud)_`;
  return text || "No tengo nada que decir sobre eso.";
}

/**
 * Bucle de herramientas: pide respuesta; si el modelo llama herramientas, las
 * ejecuta (validando argumentos) y le devuelve los resultados; repite hasta
 * que conteste con texto o se agoten las rondas.
 */
export async function runWithTools(
  messages: Message[],
  tools: Tool[],
  effort: Effort,
  complete: Complete = defaultComplete,
): Promise<string> {
  const groqTools = toGroqTools(tools);
  const convo = [...messages];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await complete({
      model: config.model,
      messages: convo,
      tools: groqTools,
      tool_choice: "auto",
      temperature: 0.3,
      max_completion_tokens: 4096,
      ...reasoning(effort),
    });
    const msg = completion.choices[0]?.message;
    const calls = msg?.tool_calls ?? [];
    if (!msg || calls.length === 0) return finalText(completion);

    convo.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
    const results = await Promise.all(
      calls.map((c) => callTool(tools, c.function.name, c.function.arguments)),
    );
    calls.forEach((c, i) => {
      convo.push({ role: "tool", tool_call_id: c.id, content: results[i] ?? "" });
    });
  }
  return "He dado demasiadas vueltas consultando datos sin llegar a una respuesta. Prueba a preguntarlo de otra forma.";
}

/**
 * Responde a una pregunta. `previous` son los turnos anteriores de la
 * conversación (solo texto); devuelve la respuesta y los dos turnos nuevos.
 */
export async function ask(
  ctx: Ctx,
  previous: ChatTurn[],
  question: string,
  complete?: Complete,
): Promise<{ answer: string; turns: ChatTurn[]; proposals: Action[] }> {
  const userTurn: ChatTurn = { role: "user", content: `[${madrid(Date.now())}] ${question}` };
  const proposals: Action[] = [];
  const tools = buildTools(ctx, proposals);
  const messages: Message[] = [{ role: "system", content: SYSTEM }, ...previous, userTurn];
  let answer = await runWithTools(messages, tools, config.chatEffort, complete);

  // Red de seguridad: a veces el modelo anuncia "voy a proponer…" sin llamar a
  // la herramienta, y Alex se queda sin botones. Una sola oportunidad más.
  if (proposals.length === 0 && announcesProposal(answer)) {
    answer = await runWithTools(
      [
        ...messages,
        { role: "assistant", content: answer },
        {
          role: "user",
          content:
            "(Aviso automático del sistema: has dicho que propones una acción pero no has llamado a proponer_accion, así que no me aparece ningún botón. Si debes proponerla, llámala ahora; si falta un dato, pregúntamelo.)",
        },
      ],
      tools,
      config.chatEffort,
      complete,
    );
  }
  return { answer, turns: [userTurn, { role: "assistant", content: answer }], proposals };
}

/** ¿La respuesta habla de proponer/confirmar una acción? */
export function announcesProposal(text: string): boolean {
  return /\b(propon\w*|propuesta|propongo|confirmaci[oó]n|confirm(a|ar|es))\b/i.test(text);
}

/** Resumen diario: junta todos los datos y pide una redacción (sin herramientas). */
export async function dailySummary(ctx: Ctx, complete = defaultComplete): Promise<string> {
  const report = await fullReport(ctx);
  const completion = await complete({
    model: config.model,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `${SUMMARY_TASK}\n\nAhora: ${madrid(Date.now())}\n\n${JSON.stringify(report, null, 1)}`,
      },
    ],
    temperature: 0.3,
    max_completion_tokens: 4096,
    ...reasoning(config.summaryEffort),
  });
  return finalText(completion);
}

/** Modelos de chat disponibles para esta API key (para elegir ASSISTANT_MODEL). */
export async function listModels(): Promise<string[]> {
  groq ??= new Groq({ apiKey: config.groqApiKey() });
  const page = await groq.models.list();
  // La API devuelve más campos de los que declara el tipo `Model`.
  const models = page.data as Array<
    Groq.Models.Model & { active?: boolean; context_window?: number }
  >;
  return models
    .filter((m) => m.active !== false)
    .map((m) => `${m.id}  (contexto ${m.context_window ?? "?"})`)
    .sort();
}
