import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  type Message,
  MessageFlags,
  Partials,
} from "discord.js";
import Groq from "groq-sdk";
import { type Action, type ActionResult, describeAction, PendingActions, runAction } from "./actions";
import { ask, type ChatTurn, dailySummary } from "./agent";
import { config } from "./config";
import type { Ctx } from "./context";
import {
  anomaliesEmbed,
  COLORS,
  downloadsEmbed,
  errorEmbed,
  expiriesEmbed,
  MAX_ANOMALIES_SHOWN,
  proposalEmbed,
  summaryEmbeds,
  textEmbeds,
} from "./embeds";
import type { Expiry } from "./expiries";
import type { Notable } from "./attacks";
import type { Anomaly } from "./logs";

/**
 * Conexión a Discord. Solo atiende DMs del owner; todo lo demás se ignora.
 * Comandos: "resumen" (lo genera ya) y "olvida" (empieza conversación nueva).
 * Las acciones que propone el modelo llegan como mensajes con botones
 * Confirmar/Cancelar; solo se ejecutan al confirmar. Los avisos de logs
 * llevan un botón para silenciar esos patrones.
 */

/** Una conversación caduca tras este silencio: la siguiente pregunta empieza de cero. */
const CONVERSATION_IDLE_MS = 30 * 60_000;
const MAX_TURNS = 20;

export function startDiscord(ctx: Ctx) {
  const client = new Client({
    intents: [GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel], // los DMs llegan como canales parciales
  });

  let turns: ChatTurn[] = [];
  let lastActivity = 0;
  /** En la oficina, el cartero sale de la secretaría con la carta. */
  const mail = (what: string) => ctx.events.push({ type: "bot.mail", level: "info", text: `El secretario te manda ${what} por Discord`, data: { what } });
  // Las preguntas se atienden de una en una, en orden.
  let queue: Promise<unknown> = Promise.resolve();
  const pending = new PendingActions();

  async function propose(msg: Message, action: Action) {
    if (!("send" in msg.channel)) return;
    const id = pending.add(action);
    await msg.channel.send({
      embeds: [proposalEmbed(action, { state: "pending" })],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`accion:ok:${id}`)
            .setLabel("Confirmar")
            .setEmoji("✅")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`accion:no:${id}`)
            .setLabel("Cancelar")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  }

  async function onButton(i: ButtonInteraction) {
    const [prefix, verdict, id] = i.customId.split(":");
    if ((prefix !== "accion" && prefix !== "logs") || !id) return;
    if (i.user.id !== ownerId || i.guildId != null) {
      await i.reply({ content: "Esto no es para ti.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (prefix === "logs") {
      // Silenciar solo cambia la base de datos del bot: sin confirmación extra.
      const fps = id.split(",");
      ctx.logs.mute(fps, verdict === "mute");
      const shown = i.message.embeds[0];
      const e = shown ? EmbedBuilder.from(shown) : new EmbedBuilder();
      await i.update({
        embeds: [e.setColor(COLORS.grey).setFooter({ text: `🔕 Silenciados (${fps.length}). Pídeme reactivarlos si hace falta.` })],
        components: [],
      });
      return;
    }
    const action = pending.take(id); // de un solo uso: un doble clic no repite
    if (!action) {
      // Sin la acción (caducada o el bot se reinició): se reutiliza el embed que había.
      const shown = i.message.embeds[0];
      const e = shown ? EmbedBuilder.from(shown) : new EmbedBuilder();
      await i.update({
        embeds: [
          e
            .setColor(COLORS.grey)
            .setFooter(null)
            .setFields({ name: "Estado", value: "⌛ Caducada o ya usada. Pídemelo otra vez." }),
        ],
        components: [],
      });
      return;
    }
    if (verdict !== "ok") {
      await i.update({ embeds: [proposalEmbed(action, { state: "cancelled" })], components: [] });
      return;
    }
    await i.update({ embeds: [proposalEmbed(action, { state: "running" })], components: [] });
    console.log(`acción confirmada: ${describeAction(action)}`);
    let result: ActionResult;
    try {
      result = await runAction(action, ctx);
    } catch (err) {
      console.error(`acción ${action.kind} fallida`, err);
      const detail = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
      result = { ok: false, text: `⚠️ Ha fallado: ${detail.slice(0, 300)}` };
    }
    ctx.events.push({
      type: "bot.action",
      level: result.ok ? "ok" : "error",
      text: `${result.ok ? "Hecho" : "Ha fallado"}: ${describeAction(action).replace(/^\p{Extended_Pictographic}\s*/u, "")}`,
      data: { kind: action.kind },
    });
    await i.editReply({
      embeds: [proposalEmbed(action, { state: "done", ok: result.ok, result: result.text })],
    });
  }

  async function handle(msg: Message) {
    const text = msg.content.trim();
    if (!text) return;
    if (Date.now() - lastActivity > CONVERSATION_IDLE_MS) turns = [];
    lastActivity = Date.now();

    if ("sendTyping" in msg.channel) await msg.channel.sendTyping().catch(() => {});
    const typing = setInterval(() => {
      if ("sendTyping" in msg.channel) msg.channel.sendTyping().catch(() => {});
    }, 8_000);
    try {
      const command = text.toLowerCase();
      if (command === "olvida" || command === "/olvida") {
        turns = [];
        await msg.reply({
          embeds: [new EmbedBuilder().setColor(COLORS.grey).setDescription("🧹 Hecho, empiezo de cero.")],
        });
        return;
      }
      if (command === "resumen" || command === "/resumen") {
        await sendEmbeds(msg, summaryEmbeds(await dailySummary(ctx)));
        mail("el resumen");
        return;
      }
      // En la oficina, el secretario se pone a teclear (sin enseñar la pregunta).
      ctx.events.push({ type: "bot.question", level: "info", text: "Alex le pregunta algo al secretario por Discord" });
      const { answer, turns: added, proposals } = await ask(ctx, turns, text);
      turns = [...turns, ...added].slice(-MAX_TURNS);
      await sendEmbeds(msg, textEmbeds(answer));
      for (const action of proposals) await propose(msg, action);
      mail("la respuesta");
    } catch (err) {
      logError(err);
      await msg.reply({ embeds: [errorEmbed(errorText(err))] }).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  }

  const ownerId = config.ownerId(); // si el .env no cuadra, falla aquí, antes de conectarse

  client.on(Events.MessageCreate, (msg) => {
    if (!isOwnerDm(msg, ownerId)) return;
    queue = queue.then(() => handle(msg));
  });

  client.on(Events.InteractionCreate, (i) => {
    if (!i.isButton()) return;
    onButton(i).catch((err) => console.error("error con un botón", err));
  });

  client.once(Events.ClientReady, (c) => console.log(`conectado a Discord como ${c.user.tag}`));
  client.login(config.discordToken());

  return {
    /** Resumen programado por DM al owner. */
    async sendSummary(text: string) {
      const user = await client.users.fetch(ownerId);
      for (const embeds of summaryEmbeds(text)) await user.send({ embeds });
      mail("el resumen de la mañana");
    },
    /** Aviso de logs con botón para silenciar los patrones que enseña. */
    async sendAnomalies(anomalies: Anomaly[]) {
      const user = await client.users.fetch(ownerId);
      const fps = anomalies.slice(0, MAX_ANOMALIES_SHOWN).map((a) => a.fp);
      await user.send({
        embeds: [anomaliesEmbed(anomalies)],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`logs:mute:${fps.join(",")}`) // ≤ 100 caracteres: 8 huellas de 10
              .setLabel(fps.length === 1 ? "Silenciar" : "Silenciar estos")
              .setEmoji("🔕")
              .setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      mail("un aviso de logs");
    },
    async sendDownloads(items: Notable[]) {
      const user = await client.users.fetch(ownerId);
      await user.send({ embeds: [downloadsEmbed(items)] });
      mail("un aviso de descargas");
    },
    async sendExpiries(items: Array<Expiry & { threshold: number }>) {
      const user = await client.users.fetch(ownerId);
      await user.send({ embeds: [expiriesEmbed(items)] });
      mail("un aviso de caducidades");
    },
    /** Hasta que Discord conecta, los avisos esperan (no se pierden ni se marcan). */
    ready: () => client.isReady(),
  };
}

/** Solo DMs (nunca canales de servidores) y solo del owner. */
export function isOwnerDm(
  msg: Pick<Message, "guildId"> & {
    author: { id: string; bot: boolean };
    channel: { type: ChannelType };
  },
  ownerId: string,
): boolean {
  return (
    !msg.author.bot &&
    msg.guildId == null &&
    msg.channel.type === ChannelType.DM &&
    msg.author.id === ownerId
  );
}

/** El primer mensaje responde a la pregunta; los demás (textos muy largos) van detrás. */
async function sendEmbeds(msg: Message, messages: EmbedBuilder[][]) {
  const [first, ...rest] = messages;
  await msg.reply({ embeds: first ?? [] });
  for (const embeds of rest) {
    if ("send" in msg.channel) await msg.channel.send({ embeds });
  }
}

/** El mensaje que da la API (p. ej. "Rate limit reached for model…"), si lo hay. */
function apiMessage(err: InstanceType<typeof Groq.APIError>): string {
  const body = err.error as { error?: { message?: string } } | undefined;
  return body?.error?.message ?? err.message;
}

export function errorText(err: unknown): string {
  if (err instanceof Groq.RateLimitError) {
    return `⚠️ Groq me ha limitado (plan gratuito); prueba en un rato. ${apiMessage(err)}`;
  }
  if (err instanceof Groq.AuthenticationError) return "⚠️ La API key de Groq no es válida.";
  if (err instanceof Groq.APIError) return `⚠️ Error de la API de Groq (${err.status}): ${apiMessage(err)}`;
  return "⚠️ Algo ha fallado al responder. Mira `journalctl -u asistente`.";
}

/** Una línea por error en el journal, sin el volcado de cabeceras. */
function logError(err: unknown) {
  if (err instanceof Groq.APIError) {
    console.error(`error de la API de Groq (${err.status}): ${apiMessage(err)}`);
  } else {
    console.error("error atendiendo un DM", err);
  }
}
