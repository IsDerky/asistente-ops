import { config } from "./config";
import { isError, type Result, type Snapshot } from "./data";

/**
 * Pterodactyl entero, en solo lectura:
 *  - inventario del panel con la Application API (clave de solo lectura):
 *    servidores de todos los nodos, dueño, límites, puertos, nodos;
 *  - estado en directo de los servidores de ESTE nodo, del recolector (Wings).
 * Nada de la API de cliente: no se entra en los servidores de nadie.
 */
export interface PteroServer {
  id: number;
  uuid: string;
  name: string;
  owner: string | null;
  node: number;
  suspended: boolean;
  /** null = normal; "installing", "install_failed", "suspended", "restoring_backup"… */
  status: string | null;
  memoryMb: number;
  diskMb: number;
  cpuPct: number;
  ports: number[];
  createdAt: string;
}

export interface PteroNode {
  id: number;
  name: string;
  fqdn: string;
  scheme: string;
  daemonPort: number;
  memoryMb: number;
  overallocatePct: number;
  allocatedMemoryMb: number;
  diskMb: number;
  allocatedDiskMb: number;
  freePorts: number[];
  usedPorts: number[];
}

export interface Inventory {
  at: number;
  servers: PteroServer[];
  nodes: PteroNode[];
}

interface ApiList<T> {
  data: Array<{ attributes: T }>;
  meta?: { pagination?: { total_pages?: number; current_page?: number } };
}

export type Fetcher = (path: string) => Promise<unknown>;

const defaultFetch: Fetcher = async (path) => {
  const res = await fetch(`${config.pterodactylUrl.replace(/\/$/, "")}/api/application/${path}`, {
    headers: { Authorization: `Bearer ${config.pterodactylKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`el panel respondió ${res.status}`);
  return res.json();
};

async function all<T>(path: string, get: Fetcher): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page < 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = (await get(`${path}${sep}per_page=100&page=${page}`)) as ApiList<T>;
    out.push(...r.data.map((d) => d.attributes));
    if ((r.meta?.pagination?.total_pages ?? 1) <= page) break;
  }
  return out;
}

type RawServer = {
  id: number;
  uuid: string;
  name: string;
  node: number;
  suspended: boolean;
  status: string | null;
  limits: { memory: number; disk: number; cpu: number };
  created_at: string;
  relationships?: {
    user?: { attributes?: { username?: string } };
    allocations?: { data?: Array<{ attributes: { port: number } }> };
  };
};
type RawNode = {
  id: number;
  name: string;
  fqdn: string;
  scheme: string;
  daemon_listen: number;
  memory: number;
  memory_overallocate: number;
  disk: number;
  allocated_resources?: { memory: number; disk: number };
  relationships?: { allocations?: { data?: Array<{ attributes: { port: number; assigned: boolean } }> } };
};

export async function fetchInventory(get: Fetcher = defaultFetch): Promise<Inventory> {
  const [servers, nodes] = await Promise.all([
    all<RawServer>("servers?include=allocations,user", get),
    all<RawNode>("nodes?include=allocations", get),
  ]);
  return {
    at: Date.now(),
    servers: servers.map((s) => ({
      id: s.id,
      uuid: s.uuid,
      name: s.name,
      owner: s.relationships?.user?.attributes?.username ?? null,
      node: s.node,
      suspended: s.suspended,
      status: s.status,
      memoryMb: s.limits.memory,
      diskMb: s.limits.disk,
      cpuPct: s.limits.cpu,
      ports: (s.relationships?.allocations?.data ?? []).map((a) => a.attributes.port).sort((a, b) => a - b),
      createdAt: s.created_at,
    })),
    nodes: nodes.map((n) => {
      const allocs = (n.relationships?.allocations?.data ?? []).map((a) => a.attributes);
      return {
        id: n.id,
        name: n.name,
        fqdn: n.fqdn,
        scheme: n.scheme,
        daemonPort: n.daemon_listen,
        memoryMb: n.memory,
        overallocatePct: n.memory_overallocate,
        allocatedMemoryMb: n.allocated_resources?.memory ?? 0,
        diskMb: n.disk,
        allocatedDiskMb: n.allocated_resources?.disk ?? 0,
        freePorts: allocs.filter((a) => !a.assigned).map((a) => a.port).sort((a, b) => a - b),
        usedPorts: allocs.filter((a) => a.assigned).map((a) => a.port).sort((a, b) => a - b),
      };
    }),
  };
}

/** ¿Responde el Wings de un nodo? (sin clave: basta con que conteste, aunque sea 401). */
export async function nodeReachable(n: PteroNode): Promise<boolean> {
  try {
    await fetch(`${n.scheme}://${n.fqdn}:${n.daemonPort}/api/system`, { signal: AbortSignal.timeout(6_000) });
    return true;
  } catch {
    return false;
  }
}

export interface WingsServer {
  uuid: string;
  state: string;
  suspended: boolean;
  mem_bytes: number | null;
  mem_limit_bytes: number | null;
  cpu_pct: number;
  disk_bytes: number | null;
  uptime_ms: number | null;
}

/** Servidores con estado en directo: los de este nodo y los de los nodos remotos configurados. */
export function wingsServers(snap: Snapshot | null): WingsServer[] {
  const w = snap?.wings;
  const local = w && !isError(w) ? w : [];
  const r = snap?.wings_remote;
  const remote = r && !isError(r) ? Object.values(r).flatMap((n) => n.servers ?? []) : [];
  return [...local, ...remote];
}

/** Solo los de este nodo (para saber cuál es "este servidor"). */
export function localWingsServers(snap: Snapshot | null): WingsServer[] {
  const w = snap?.wings;
  return w && !isError(w) ? w : [];
}

const GB = 1024 ** 3;
const gb = (bytes: number | null | undefined) => (bytes == null ? "?" : `${(bytes / GB).toFixed(1)} GB`);

/** Todo junto y legible, para el bot y la oficina. */
export function pteroView(inv: Result<Inventory> | null, snap: Snapshot | null, reach: Map<number, boolean>) {
  if (!inv) return { error: "todavía no se ha leído el panel" };
  if (isError(inv)) return inv;
  const live = new Map(wingsServers(snap).map((w) => [w.uuid, w]));
  const localSet = new Set(localWingsServers(snap).map((w) => w.uuid));
  const physical = snap?.system.mem_total ?? null;
  return {
    nota: "Inventario del panel (todos los nodos) + estado en directo de los servidores de este nodo. Solo lectura; nunca se actúa dentro de los servidores de los clientes.",
    nodos: inv.nodes.map((n) => {
      const local = inv.servers.some((s) => s.node === n.id && localSet.has(s.uuid));
      const declared = n.memoryMb * 1024 ** 2;
      return {
        id: n.id,
        nombre: n.name,
        dominio: n.fqdn,
        este_servidor: local,
        responde: reach.get(n.id) ?? null,
        ram_declarada: gb(declared),
        sobreasignacion: `${n.overallocatePct} %`,
        ram_prometida: gb(n.allocatedMemoryMb * 1024 ** 2),
        ...(local && physical
          ? {
              ram_fisica: gb(physical),
              aviso:
                n.allocatedMemoryMb * 1024 ** 2 > physical
                  ? `Hay ${gb(n.allocatedMemoryMb * 1024 ** 2)} prometidos a servidores en una máquina de ${gb(physical)}: si se encienden todos, faltará memoria.`
                  : null,
            }
          : {}),
        puertos_libres: n.freePorts,
        servidores: inv.servers.filter((s) => s.node === n.id).length,
      };
    }),
    servidores: inv.servers.map((s) => {
      const l = live.get(s.uuid);
      return {
        nombre: s.name,
        dueno: s.owner,
        nodo: inv.nodes.find((n) => n.id === s.node)?.name ?? s.node,
        estado: s.suspended ? "suspendido" : s.status ? s.status : l ? l.state : "sin datos (su nodo no está en wings-nodes.env)",
        ram: l ? `${gb(l.mem_bytes)} de ${s.memoryMb ? `${(s.memoryMb / 1024).toFixed(0)} GB` : "sin límite"}` : `límite ${s.memoryMb ? `${(s.memoryMb / 1024).toFixed(0)} GB` : "sin límite"}`,
        cpu: l ? `${l.cpu_pct} % (límite ${s.cpuPct} %)` : `límite ${s.cpuPct} %`,
        disco: l ? `${gb(l.disk_bytes)} de ${(s.diskMb / 1024).toFixed(0)} GB` : `límite ${(s.diskMb / 1024).toFixed(0)} GB`,
        puertos: s.ports,
        creado: s.createdAt.slice(0, 10),
      };
    }),
  };
}

/** Inventario en memoria (se refresca cada 5 min) y lo que ha cambiado. */
export class PteroStore {
  inv: Result<Inventory> | null = null;
  reach = new Map<number, boolean>();
  private lastStates: Map<string, string> | null = null;

  constructor(private readonly get: Fetcher = defaultFetch) {}

  get enabled(): boolean {
    return Boolean(config.pterodactylKey);
  }

  /** Relee el panel y comprueba los nodos. Devuelve los eventos de inventario. */
  async refresh(localUuids: Set<string>): Promise<Array<{ type: string; level: "info" | "ok" | "warn" | "error"; text: string; data?: Record<string, unknown> }>> {
    if (!this.enabled) return [];
    const prev = this.inv && !isError(this.inv) ? this.inv : null;
    const prevReach = new Map(this.reach);
    try {
      this.inv = await fetchInventory(this.get);
    } catch (err) {
      this.inv = { error: `no se pudo leer el panel: ${(err as Error).message}` };
      return [];
    }
    const inv = this.inv;
    // Los nodos de fuera se comprueban por la red; el de aquí ya lo ve el recolector.
    await Promise.all(
      inv.nodes.map(async (n) => {
        const local = inv.servers.some((s) => s.node === n.id && localUuids.has(s.uuid));
        this.reach.set(n.id, local ? true : await nodeReachable(n));
      }),
    );
    const events: Awaited<ReturnType<PteroStore["refresh"]>> = [];
    if (prev) {
      const before = new Map(prev.servers.map((s) => [s.id, s]));
      for (const s of inv.servers) {
        const o = before.get(s.id);
        if (!o) events.push({ type: "server.new", level: "info", text: `Nuevo servidor en el panel: ${s.name}${s.owner ? ` (de ${s.owner})` : ""}`, data: { name: s.name } });
        else if (!o.suspended && s.suspended) events.push({ type: "server.suspended", level: "warn", text: `Suspendido: ${s.name}`, data: { name: s.name } });
        else if (o.status !== "install_failed" && s.status === "install_failed") events.push({ type: "server.install_failed", level: "error", text: `Ha fallado la instalación de ${s.name}`, data: { name: s.name } });
      }
      for (const n of inv.nodes) {
        const was = prevReach.get(n.id);
        const is = this.reach.get(n.id);
        if (was === true && is === false) events.push({ type: "node.down", level: "error", text: `El nodo ${n.name} no responde`, data: { node: n.name } });
        if (was === false && is === true) events.push({ type: "node.up", level: "ok", text: `El nodo ${n.name} vuelve a responder`, data: { node: n.name } });
      }
    }
    return events;
  }

  /** Arranques y paradas de los servidores de este nodo (de una foto a la siguiente). */
  stateChanges(snap: Snapshot | null) {
    const live = wingsServers(snap);
    if (!live.length) return [];
    const names = new Map((this.inv && !isError(this.inv) ? this.inv.servers : []).map((s) => [s.uuid, s.name]));
    const now = new Map(live.map((w) => [w.uuid, w.state]));
    const prev = this.lastStates;
    this.lastStates = now;
    if (!prev) return [];
    const out: Array<{ type: string; level: "info" | "ok" | "warn" | "error"; text: string; data?: Record<string, unknown> }> = [];
    for (const [uuid, state] of now) {
      const was = prev.get(uuid);
      if (!was || was === state) continue;
      const name = names.get(uuid) ?? uuid.slice(0, 8);
      if (state === "running") out.push({ type: "server.start", level: "ok", text: `Arranca ${name}`, data: { uuid, name } });
      else if (state === "offline" && was === "running") out.push({ type: "server.stop", level: "warn", text: `Se ha parado ${name}`, data: { uuid, name } });
    }
    return out;
  }
}
