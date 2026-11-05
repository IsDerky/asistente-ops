import { Attacks } from "./attacks";
import { ClaudeSessions } from "./claude";
import { EventLog } from "./events";
import { Expiries, type FetchJson } from "./expiries";
import { History } from "./history";
import { Incidents } from "./incidents";
import { LogWatch } from "./logs";
import { PteroStore } from "./ptero";
import { SpotifyStore } from "./spotify";
import { WeatherStore } from "./weather";

/** Todo lo que el bot guarda, sobre la misma base de datos SQLite. */
export interface Ctx {
  history: History;
  logs: LogWatch;
  incidents: Incidents;
  expiries: Expiries;
  attacks: Attacks;
  events: EventLog;
  ptero: PteroStore;
  /** Sesiones de Claude Code del PC (en memoria). */
  claude: ClaudeSessions;
  /** El tiempo de ahora, para las ventanas de la oficina (en memoria). */
  weather: WeatherStore;
  /** Lo que suena en Spotify, para el tocadiscos (en memoria). */
  spotify: SpotifyStore;
}

export function openContext(path?: string, opts: { fetchJson?: FetchJson } = {}): Ctx {
  const history = new History(path);
  return {
    history,
    logs: new LogWatch(history.db),
    incidents: new Incidents(history.db),
    expiries: new Expiries(history.db, opts.fetchJson),
    attacks: new Attacks(history.db),
    events: new EventLog(history.db),
    ptero: new PteroStore(),
    claude: new ClaudeSessions(),
    weather: new WeatherStore(),
    spotify: new SpotifyStore(),
  };
}
