import { z } from "zod";
import { ACTION_KINDS, type Action, describeAction } from "./actions";
import {
  bentonimeAnime,
  bentonimeSearch,
  bentonimeSummary,
  isError,
  readSnapshot,
  watchdogStatus,
} from "./data";
import type { Ctx } from "./context";
import { pteroView } from "./ptero";
import {
  backupsView,
  containersView,
  expiriesView,
  logsView,
  simulacroView,
  systemView,
} from "./views";

/**
 * Herramientas del asistente. Leen datos, salvo:
 *  - proponer_accion / proponer_incidente, que tampoco ejecutan nada: dejan
 *    la acción en `proposals` para que el bot la enseñe con botones;
 *  - silenciar_logs, recordar_fecha y borrar_recordatorio, que solo tocan la
 *    base de datos del propio bot (sin efecto en el servidor).
 */
export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>) => Promise<string>;
}

const json = (v: unknown) => JSON.stringify(v, null, 1);

function tool<S extends z.ZodType>(t: Tool<S>): Tool {
  return t as unknown as Tool;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function buildTools(ctx: Ctx, proposals: Action[] = []): Tool[] {
  const { history } = ctx;
  return [
    tool({
      name: "estado_servidor",
      description:
        "Estado actual del servidor (OptiPlex): carga, RAM, swap, discos, salud SMART del SSD y estado de los servicios systemd (bentonime, cloudflared, nginx, wings, mariadb, docker…). Datos del recolector, refrescados cada 5 min.",
      schema: z.object({}),
      run: async () => {
        const snap = await readSnapshot();
        return json(isError(snap) ? snap : systemView(snap));
      },
    }),
    tool({
      name: "backups",
      description:
        "Última ejecución de cada backup con restic a Google Drive (sistema cada 6 h, clientes a diario a las 05:30, mantenimiento los domingos), el último simulacro de restauración (mensual) y lo que ve el vigilante externo de Cloudflare.",
      schema: z.object({}),
      run: async () => {
        const [snap, watchdog] = await Promise.all([readSnapshot(), watchdogStatus()]);
        return json({
          ejecuciones: isError(snap) ? snap : backupsView(snap),
          simulacro_restauracion: isError(snap) ? snap : simulacroView(snap),
          vigilante_externo: watchdog,
        });
      },
    }),
    tool({
      name: "logs",
      description:
        "Anomalías en los logs del servidor (journal): patrones de error nunca vistos antes, los más frecuentes, bloqueos del cortafuegos y los silenciados. Cada patrón tiene una 'huella'.",
      schema: z.object({
        horas: z.number().int().min(1).max(720).optional().describe("Ventana en horas (por defecto 24)."),
      }),
      run: async ({ horas }: { horas?: number }) => json(logsView(ctx, horas ?? 24)),
    }),
    tool({
      name: "ataques",
      description:
        "Quién ataca lo que está abierto a internet: fuerza bruta al SFTP de Wings, sondas web a nginx y el honeypot (SSH/Telnet falsos, con usuarios, contraseñas, comandos y descargas). Con país y red de cada IP. Nada de esto ha entrado en el servidor real.",
      schema: z.object({
        horas: z.number().int().min(1).max(720).optional().describe("Ventana en horas (por defecto 24)."),
      }),
      run: async ({ horas }: { horas?: number }) => {
        const { linea_de_tiempo: _, ...rest } = ctx.attacks.summary(horas ?? 24);
        return json(rest);
      },
    }),
    tool({
      name: "pterodactyl",
      description:
        "Todo Pterodactyl: nodos (RAM declarada, prometida y física, puertos libres, si responden) y todos los servidores de todos los nodos con dueño, estado, límites y consumo en directo (los de este nodo). Solo lectura.",
      schema: z.object({}),
      run: async () => {
        const snap = await readSnapshot();
        return json(pteroView(ctx.ptero.inv, isError(snap) ? null : snap, ctx.ptero.reach));
      },
    }),
    tool({
      name: "silenciar_logs",
      description:
        "Silencia (o reactiva) patrones de log por su huella para que dejen de avisar. Solo afecta a los avisos del bot. Úsala solo si Alex lo pide.",
      schema: z.object({
        huellas: z.array(z.string().min(4).max(20)).min(1).max(20),
        silenciar: z.boolean().optional().describe("false para reactivar (por defecto true)"),
      }),
      run: async ({ huellas, silenciar }: { huellas: string[]; silenciar?: boolean }) => {
        const n = ctx.logs.mute(huellas, silenciar ?? true);
        return json({ hecho: `${n} de ${huellas.length} patrones ${silenciar === false ? "reactivados" : "silenciados"}` });
      },
    }),
    tool({
      name: "buscar_incidentes",
      description:
        "Busca en la memoria de incidentes pasados (síntoma, causa y solución). Úsala SIEMPRE antes de diagnosticar un problema, por si ya pasó. Sin texto devuelve los más recientes.",
      schema: z.object({ texto: z.string().max(200).optional().describe("Palabras clave del síntoma o servicio") }),
      run: async ({ texto }: { texto?: string }) => {
        const found = texto ? ctx.incidents.search(texto) : ctx.incidents.recent();
        return json(found.length ? found : { nada: "no hay incidentes parecidos apuntados" });
      },
    }),
    tool({
      name: "proponer_incidente",
      description:
        "Propone apuntar un incidente resuelto en la memoria (Alex lo confirma con un botón). Úsala cuando Alex lo pida o cuando acabéis de resolver un problema y él esté de acuerdo. Escribe en español, concreto y sin inventar.",
      schema: z.object({
        fecha: z.string().regex(DAY_RE).describe("Día del incidente, YYYY-MM-DD"),
        titulo: z.string().min(5).max(120),
        sintoma: z.string().min(5).max(600),
        causa: z.string().min(3).max(600),
        solucion: z.string().min(3).max(800),
      }),
      run: async (i: { fecha: string; titulo: string; sintoma: string; causa: string; solucion: string }) => {
        proposals.push({
          kind: "registrar_incidente",
          day: i.fecha,
          title: i.titulo,
          symptom: i.sintoma,
          cause: i.causa,
          solution: i.solucion,
        });
        return json({ estado: "Pendiente: Alex verá botones Confirmar/Cancelar. NO está apuntado todavía." });
      },
    }),
    tool({
      name: "caducidades",
      description:
        "Fechas de caducidad: certificados TLS (certbot renueva solo a 30 días), dominios (RDAP) y recordatorios que ha apuntado Alex (con su id). Ordenadas por días que faltan.",
      schema: z.object({
        dias: z.number().int().min(1).max(3650).optional().describe("Solo lo que caduca en este plazo"),
      }),
      run: async ({ dias }: { dias?: number }) => {
        const snap = await readSnapshot();
        return json(expiriesView(ctx, isError(snap) ? null : snap, dias));
      },
    }),
    tool({
      name: "recordar_fecha",
      description:
        "Apunta una fecha para avisar con antelación (a 30, 7 y 1 día): renovaciones (Google One…), cambiar la pila CMOS, etc. Solo si Alex lo pide.",
      schema: z.object({
        que: z.string().min(3).max(120),
        fecha: z.string().regex(DAY_RE).describe("YYYY-MM-DD"),
        notas: z.string().max(300).optional(),
      }),
      run: async ({ que, fecha, notas }: { que: string; fecha: string; notas?: string }) => {
        if (Number.isNaN(Date.parse(fecha))) return json({ error: "fecha inválida" });
        const id = ctx.expiries.addReminder(que, fecha, notas);
        return json({ hecho: `Apuntado (recordatorio #${id}) para el ${fecha}` });
      },
    }),
    tool({
      name: "borrar_recordatorio",
      description: "Borra un recordatorio por su id (ver caducidades). Solo si Alex lo pide.",
      schema: z.object({ id: z.number().int().positive() }),
      run: async ({ id }: { id: number }) =>
        json(ctx.expiries.removeReminder(id) ? { hecho: `Recordatorio #${id} borrado` } : { error: "no existe" }),
    }),
    tool({
      name: "clientes",
      description:
        "RAM y CPU de los servidores de juego de los clientes (contenedores de Pterodactyl): valor actual y pico/media en la ventana pedida. Ordenados por RAM.",
      schema: z.object({
        horas: z
          .number()
          .int()
          .min(1)
          .max(336)
          .optional()
          .describe("Ventana para el pico y la media, en horas (por defecto 24; máximo 14 días)."),
      }),
      run: async ({ horas }: { horas?: number }) => {
        const snap = await readSnapshot();
        return json(isError(snap) ? snap : containersView(snap, history, horas ?? 24));
      },
    }),
    tool({
      name: "bentonime",
      description:
        "Bentonime (la app de anime del owner): episodios nuevos de los animes que está viendo (y si ya están descargados), cola de descargas, descargas fallidas recientes, espacio offline y crons con error.",
      schema: z.object({
        horas: z
          .number()
          .int()
          .min(1)
          .max(168)
          .optional()
          .describe("Ventana de 'nuevo' y de fallos recientes, en horas (por defecto 24)."),
      }),
      run: async ({ horas }: { horas?: number }) => json(await bentonimeSummary(horas ?? 24)),
    }),
    tool({
      name: "buscar_anime",
      description:
        "Busca un anime en Bentonime por nombre y devuelve candidatos con su slug. Úsala antes de mirar episodios o proponer encolar si no tienes el slug exacto.",
      schema: z.object({ texto: z.string().min(2).max(128).describe("Nombre o parte del nombre") }),
      run: async ({ texto }: { texto: string }) => json(await bentonimeSearch(texto)),
    }),
    tool({
      name: "episodios_anime",
      description:
        "Episodios de un anime de Bentonime (por slug): cuántos hay, cuáles están descargados, cuáles en cola y cuáles se pueden encolar.",
      schema: z.object({ slug: z.string().min(1).max(256) }),
      run: async ({ slug }: { slug: string }) => json(await bentonimeAnime(slug)),
    }),
    tool({
      name: "proponer_accion",
      description:
        "Propone una acción para que Alex la confirme con un botón. NO la ejecuta. Acciones: reiniciar_bentonime; backup_sistema (lanzar ya el backup de sistema); encolar_episodios (requiere slug exacto y la lista de números de episodio). Si Alex no ha pedido explícitamente la acción, no la propongas.",
      schema: z.object({
        accion: z.enum(ACTION_KINDS),
        slug: z.string().min(1).max(256).optional().describe("Solo para encolar_episodios"),
        episodios: z
          .array(z.number().int().positive())
          .min(1)
          .max(500)
          .optional()
          .describe("Solo para encolar_episodios: números de episodio, p. ej. [1,2,3]"),
      }),
      run: async (input: { accion: (typeof ACTION_KINDS)[number]; slug?: string; episodios?: number[] }) => {
        const action = await buildAction(input);
        if (typeof action === "string") return json({ error: action });
        proposals.push(action);
        return json({
          propuesta: describeAction(action).replace(/\*\*/g, ""),
          estado:
            "Pendiente: Alex verá botones Confirmar/Cancelar. NO está hecha; no digas que lo está.",
        });
      },
    }),
  ];
}

/** Valida una propuesta y la completa (título del anime). Texto = error. */
async function buildAction(input: {
  accion: (typeof ACTION_KINDS)[number];
  slug?: string;
  episodios?: number[];
}): Promise<Action | string> {
  if (input.accion !== "encolar_episodios") return { kind: input.accion };
  if (!input.slug || !input.episodios?.length) {
    return "encolar_episodios necesita slug y episodios";
  }
  const anime = await bentonimeAnime(input.slug);
  if (isError(anime)) return `no encuentro ese anime: ${anime.error}`;
  return {
    kind: "encolar_episodios",
    slug: anime.slug,
    title: anime.title,
    episodes: [...new Set(input.episodios)].sort((a, b) => a - b),
  };
}

/**
 * Ejecuta una llamada del modelo: los argumentos llegan como texto JSON y se
 * validan con el esquema antes de tocar nada. Los errores vuelven al modelo
 * como resultado, para que pueda corregirse, en vez de tumbar la respuesta.
 */
export async function callTool(tools: Tool[], name: string, rawArgs: string): Promise<string> {
  const t = tools.find((x) => x.name === name);
  if (!t) return json({ error: `no existe la herramienta ${name}` });
  let args: unknown;
  try {
    args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return json({ error: "argumentos que no son JSON válido", recibido: rawArgs.slice(0, 200) });
  }
  const parsed = t.schema.safeParse(args ?? {});
  if (!parsed.success) return json({ error: "argumentos inválidos", detalle: parsed.error.message });
  try {
    return await t.run(parsed.data);
  } catch (err) {
    return json({ error: `la herramienta falló: ${(err as Error).message}` });
  }
}
