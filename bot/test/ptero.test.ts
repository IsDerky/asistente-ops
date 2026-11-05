import { describe, expect, test } from "bun:test";
import { fetchInventory, PteroStore, pteroView } from "../src/ptero";
import { snapshot } from "./fixtures";

const GB = 1024 ** 3;

const servers = {
  data: [
    {
      attributes: {
        id: 112,
        uuid: "30c38de2-aaaa",
        name: "Survival",
        node: 1,
        suspended: false,
        status: null,
        limits: { memory: 18432, disk: 51200, cpu: 300 },
        created_at: "2026-10-12T10:00:00+00:00",
        relationships: { user: { attributes: { username: "cliente1" } }, allocations: { data: [{ attributes: { port: 10005 } }] } },
      },
    },
    {
      attributes: {
        id: 200,
        uuid: "ffff-remote",
        name: "En Francia",
        node: 2,
        suspended: false,
        status: null,
        limits: { memory: 6144, disk: 20480, cpu: 100 },
        created_at: "2026-10-01T10:00:00+00:00",
        relationships: { user: { attributes: { username: "derkyu" } }, allocations: { data: [{ attributes: { port: 10001 } }] } },
      },
    },
  ],
  meta: { pagination: { total_pages: 1 } },
};
const nodes = {
  data: [
    { attributes: { id: 1, name: "nodo-1", fqdn: "nodo1.example.com", scheme: "https", daemon_listen: 8080, memory: 65536, memory_overallocate: 100, disk: 1048576, allocated_resources: { memory: 52224, disk: 317440 }, relationships: { allocations: { data: [{ attributes: { port: 10005, assigned: true } }, { attributes: { port: 10006, assigned: false } }] } } } },
    { attributes: { id: 2, name: "nodo-2", fqdn: "n1.invalid", scheme: "https", daemon_listen: 8080, memory: 24576, memory_overallocate: 0, disk: 102400, allocated_resources: { memory: 6144, disk: 20480 }, relationships: { allocations: { data: [] } } } },
  ],
  meta: { pagination: { total_pages: 1 } },
};
const fake = async (path: string) => (path.startsWith("servers") ? servers : nodes);

describe("pterodactyl", () => {
  test("inventario: servidores de todos los nodos, dueños, puertos y nodos", async () => {
    const inv = await fetchInventory(fake);
    expect(inv.servers.map((s) => [s.name, s.owner, s.ports])).toEqual([
      ["Survival", "cliente1", [10005]],
      ["En Francia", "derkyu", [10001]],
    ]);
    expect(inv.nodes[0]).toMatchObject({ name: "nodo-1", allocatedMemoryMb: 52224, freePorts: [10006], usedPorts: [10005] });
  });

  test("vista: consumo en directo de los de este nodo y aviso de RAM prometida de más", async () => {
    const inv = await fetchInventory(fake);
    const snap = {
      ...snapshot(new Date()),
      wings: [{ uuid: "30c38de2-aaaa", state: "running", suspended: false, mem_bytes: 6.4 * GB, mem_limit_bytes: 18 * GB, cpu_pct: 8.4, disk_bytes: 12 * GB, uptime_ms: 1000 }],
    };
    const v = pteroView(inv, snap, new Map([[1, true], [2, false]])) as {
      nodos: Array<Record<string, unknown>>;
      servidores: Array<Record<string, unknown>>;
    };
    expect(v.nodos[0]).toMatchObject({ nombre: "nodo-1", este_servidor: true, responde: true, ram_prometida: "51.0 GB", ram_fisica: "38.0 GB" });
    expect(String(v.nodos[0]?.aviso)).toContain("faltará memoria");
    expect(v.nodos[1]).toMatchObject({ nombre: "nodo-2", este_servidor: false, responde: false });
    expect(v.servidores[0]).toMatchObject({ nombre: "Survival", dueno: "cliente1", estado: "running", ram: "6.4 GB de 18 GB" });
    expect(v.servidores[1]).toMatchObject({ estado: "sin datos (su nodo no está en wings-nodes.env)" });

    // Con el token del nodo remoto, su servidor también tiene estado; "este servidor" sigue siendo el local.
    const withRemote = {
      ...snap,
      wings_remote: { "n1.invalid": { servers: [{ uuid: "ffff-remote", state: "offline", suspended: false, mem_bytes: 0, mem_limit_bytes: 0, cpu_pct: 0, disk_bytes: 0, uptime_ms: 0 }] } },
    };
    const v2 = pteroView(inv, withRemote, new Map([[1, true], [2, true]])) as typeof v;
    expect(v2.servidores[1]).toMatchObject({ estado: "offline" });
    expect(v2.nodos.map((n) => n.este_servidor)).toEqual([true, false]);
  });

  test("eventos: altas nuevas, arranques y paradas", async () => {
    let call = 0;
    const store = new PteroStore(async (path) => {
      if (path.startsWith("servers") && call++ === 0) return { ...servers, data: servers.data.slice(0, 1) };
      return path.startsWith("servers") ? servers : nodes;
    });
    Object.defineProperty(store, "enabled", { get: () => true });
    const local = new Set(["30c38de2-aaaa"]);
    expect(await store.refresh(local)).toEqual([]);
    const second = await store.refresh(local);
    expect(second.map((e) => e.type)).toContain("server.new");

    const snap = (state: string) => ({
      ...snapshot(new Date()),
      wings: [{ uuid: "30c38de2-aaaa", state, suspended: false, mem_bytes: 0, mem_limit_bytes: 0, cpu_pct: 0, disk_bytes: 0, uptime_ms: 0 }],
    });
    expect(store.stateChanges(snap("running"))).toEqual([]);
    expect(store.stateChanges(snap("offline"))).toEqual([
      { type: "server.stop", level: "warn", text: "Se ha parado Survival", data: { uuid: "30c38de2-aaaa", name: "Survival" } },
    ]);
    expect(store.stateChanges(snap("running"))[0]?.type).toBe("server.start");
  });
});
