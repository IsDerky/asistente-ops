import { config } from "./config";

/**
 * El tiempo que hace ahora (Open-Meteo, sin clave), para las ventanas de la
 * oficina. Solo lo que se pinta: lluvia, nieve, tormenta, nubes y si es de día.
 * Si falla o lleva más de 2 h sin actualizarse, la oficina pinta el cielo sin
 * tiempo (como antes).
 */
export type Sky = "clear" | "cloudy" | "fog" | "rain" | "snow" | "storm";

export interface Weather {
  sky: Sky;
  /** Precipitación en mm/h (más gotas cuanto más llueve). */
  precipitation: number;
  cloudCover: number;
  at: number;
}

export type FetchJson = (url: string) => Promise<unknown>;

const STALE_MS = 2 * 3600_000;

const defaultFetch: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Open-Meteo respondió ${res.status}`);
  return res.json();
};

/** Códigos WMO de Open-Meteo agrupados en lo que se pinta. */
export function skyOf(code: number): Sky {
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if (code === 45 || code === 48) return "fog";
  if (code >= 2) return "cloudy";
  return "clear";
}

export class WeatherStore {
  private last: Weather | null = null;

  constructor(private readonly fetchJson: FetchJson = defaultFetch) {}

  now(at = Date.now()): Weather | null {
    return this.last && at - this.last.at <= STALE_MS ? this.last : null;
  }

  async refresh(at = Date.now()): Promise<void> {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${config.weatherLat}&longitude=${config.weatherLon}` +
      "&current=weather_code,precipitation,cloud_cover";
    const body = (await this.fetchJson(url)) as { current?: { weather_code?: unknown; precipitation?: unknown; cloud_cover?: unknown } };
    const c = body.current;
    if (typeof c?.weather_code !== "number") throw new Error("Open-Meteo sin weather_code");
    this.last = {
      sky: skyOf(c.weather_code),
      precipitation: typeof c.precipitation === "number" ? c.precipitation : 0,
      cloudCover: typeof c.cloud_cover === "number" ? c.cloud_cover : 0,
      at,
    };
  }
}
