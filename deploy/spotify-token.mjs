// Saca (una vez) el refresh token de Spotify para el widget de derkyu.com (portfolio),
// que es también de donde lee el tocadiscos de la oficina. Se ejecuta en el PC con Node,
// con http://127.0.0.1:8888/callback puesto en los "Redirect URIs" de la app de Spotify:
//
//   node deploy/spotify-token.mjs <client_id> <client_secret>
//
// Abre la URL que imprime y acepta (solo lectura: qué suena y lo último escuchado).
// Pon el SPOTIFY_REFRESH_TOKEN que sale al final en las variables de entorno del
// proyecto portfolio de Vercel y vuelve a desplegar. El token no se guarda en ningún archivo.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("Uso: node deploy/spotify-token.mjs <client_id> <client_secret>");
  process.exit(1);
}
const REDIRECT = "http://127.0.0.1:8888/callback";
const state = randomBytes(16).toString("hex");
const auth = new URL("https://accounts.spotify.com/authorize");
auth.search = new URLSearchParams({
  client_id: clientId,
  response_type: "code",
  redirect_uri: REDIRECT,
  scope: "user-read-currently-playing user-read-recently-played",
  state,
}).toString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", REDIRECT);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== state || !code) {
    res.writeHead(400).end("Respuesta rara de Spotify (state o code). Vuelve a empezar.");
    return;
  }
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT }),
  });
  const body = await r.json();
  if (!r.ok || !body.refresh_token) {
    res.writeHead(500).end("Spotify no ha dado el token; mira la terminal.");
    console.error("Error de Spotify:", body);
    server.close();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Listo. Ya puedes cerrar esta pestaña y volver a la terminal.");
  console.log("\nPon esto en Vercel (portfolio → Settings → Environment Variables, Production) y vuelve a desplegar:\n");
  console.log(`SPOTIFY_REFRESH_TOKEN=${body.refresh_token}\n`);
  console.log("(SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET ya están en Vercel; solo cambian si has usado otra app.)\n");
  server.close();
});

server.listen(8888, "127.0.0.1", () => {
  console.log("Abre esto en el navegador y acepta:\n");
  console.log(auth.toString());
});
