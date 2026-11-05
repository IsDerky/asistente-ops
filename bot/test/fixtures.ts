import type { Snapshot } from "../src/data";

const GB = 1024 ** 3;

export function snapshot(at: Date, mcMemGb = 7.8): Snapshot {
  return {
    collected_at: at.toISOString(),
    system: {
      hostname: "servidor",
      uptime_s: 3 * 86_400 + 3600,
      load: [0.4, 0.3, 0.2],
      cpus: 6,
      mem_total: 38 * GB,
      mem_available: 29 * GB,
      swap_used: 0,
      disks: { "/": { total: 238 * GB, used: 118 * GB, free: 120 * GB } },
    },
    smart: { passed: true, temperature_c: 34, wear_remaining_pct: 96, reallocated_sectors: 0 },
    services: {
      bentonime: { ActiveState: "active", SubState: "running", LoadState: "loaded", NRestarts: "0" },
      wings: { ActiveState: "failed", SubState: "failed", LoadState: "loaded", NRestarts: "3" },
    },
    backups: {
      sistema: {
        ActiveState: "inactive",
        Result: "success",
        ExecMainStatus: "0",
        ExecMainStartTimestamp: 1_793_240_000,
        ExecMainExitTimestamp: 1_793_240_300,
      },
      clientes: {
        ActiveState: "inactive",
        Result: "success",
        ExecMainStatus: "0",
        ExecMainStartTimestamp: "",
        ExecMainExitTimestamp: "",
      },
    },
    containers: [
      {
        container: "uuid-mc",
        server: "Survival de Pepe",
        cpu_pct: 12.5,
        mem_bytes: mcMemGb * GB,
        mem_limit_bytes: 20 * GB,
      },
      { container: "adguard", server: null, cpu_pct: 0.2, mem_bytes: 0.1 * GB, mem_limit_bytes: null },
    ],
  };
}
