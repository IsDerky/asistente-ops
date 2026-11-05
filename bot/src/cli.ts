/**
 * Pruebas por terminal, sin Discord:
 *   bun run resumen                  imprime el resumen diario
 *   bun run preguntar "¿qué tal?"    responde una pregunta
 *   bun src/cli.ts informe           el JSON que recibe el resumen (sin IA)
 *   bun src/cli.ts modelos           modelos de Groq disponibles para la API key
 */
import { ask, dailySummary, listModels } from "./agent";
import { openContext } from "./context";
import { fullReport } from "./views";

const [command, ...rest] = process.argv.slice(2);
const ctx = openContext();

if (command === "resumen") {
  console.log(await dailySummary(ctx));
} else if (command === "preguntar" && rest.length > 0) {
  console.log((await ask(ctx, [], rest.join(" "))).answer);
} else if (command === "informe") {
  console.log(JSON.stringify(await fullReport(ctx), null, 2));
} else if (command === "modelos") {
  console.log((await listModels()).join("\n"));
} else {
  console.error('Uso: bun src/cli.ts resumen | preguntar "<pregunta>" | informe | modelos');
  process.exit(2);
}
