import { config } from "./config";

/**
 * Lo que suena ahora en el Spotify de Alex, para el tocadiscos de la sala
 * audiovisual. No habla con Spotify: lee el widget público de derkyu.com
 * (`/api/spotify` del portfolio), que es el único que guarda el token. Así hay
 * una sola app de Spotify y un solo token, en Vercel. Con SPOTIFY_NOW_URL vacío,
 * desactivado. Solo se guarda título, artista y tiempos.
 */
export interface Music {
  playing: boolean;
  title: string;
  artist: string;
  progressMs: number;
  durationMs: number;
  at: number;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Sin noticias en este tiempo (derkyu.com caído, token roto), no se pinta nada. */
const STALE_MS = 2 * 60_000;

/** Lo que devuelve /api/spotify del portfolio. */
interface WidgetBody {
  isPlaying?: boolean;
  error?: string;
  title?: string;
  artist?: string;
  progress?: number;
  duration?: number;
  /** Cuándo lo preguntó a Spotify (la respuesta puede venir de la caché de la CDN). */
  fetchedAt?: number;
}

export class SpotifyStore {
  private last: Music | null = null;

  constructor(private readonly fetcher: Fetcher = (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(10_000) })) {}

  get enabled(): boolean {
    return Boolean(config.spotifyNowUrl);
  }

  now(at = Date.now()): Music | null {
    return this.last && at - this.last.at <= STALE_MS ? this.last : null;
  }

  async refresh(at = Date.now()): Promise<void> {
    if (!this.enabled) return;
    const res = await this.fetcher(config.spotifyNowUrl, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`El widget de Spotify respondió ${res.status}`);
    const b = (await res.json()) as WidgetBody;
    // El widget responde 200 con `error` si su token falla: mejor no pintar nada que algo viejo.
    if (b.error) throw new Error(`El widget de Spotify dice: ${b.error}`);
    // Sin sonar, el widget da la última canción escuchada; el tocadiscos solo quiere saber que está parado.
    if (!b.isPlaying) {
      this.last = { playing: false, title: "", artist: "", progressMs: 0, durationMs: 0, at };
      return;
    }
    const durationMs = b.duration ?? 0;
    // Si viene de la caché de la CDN, adelantar el progreso lo que haya pasado desde entonces.
    const lag = b.fetchedAt ? Math.max(0, at - b.fetchedAt) : 0;
    this.last = {
      playing: true,
      title: (b.title ?? "").slice(0, 80),
      artist: (b.artist ?? "").slice(0, 80),
      progressMs: Math.min((b.progress ?? 0) + lag, durationMs || Number.POSITIVE_INFINITY),
      durationMs,
      at,
    };
  }
}
