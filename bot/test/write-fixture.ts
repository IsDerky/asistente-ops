// Escribe un snapshot de ejemplo reciente: bun test/write-fixture.ts <ruta>
import { writeFileSync } from "node:fs";
import { snapshot } from "./fixtures";

writeFileSync(process.argv[2] ?? "/tmp/snapshot.json", JSON.stringify(snapshot(new Date())));
