import { describe, expect, test } from "bun:test";
import { skyOf, WeatherStore } from "../src/weather";

describe("tiempo para la oficina", () => {
  test("códigos WMO agrupados en lo que se pinta", () => {
    expect([0, 1, 2, 3, 45, 61, 81, 73, 86, 95, 99].map(skyOf)).toEqual([
      "clear",
      "clear",
      "cloudy",
      "cloudy",
      "fog",
      "rain",
      "rain",
      "snow",
      "snow",
      "storm",
      "storm",
    ]);
  });

  test("guarda lo último y lo olvida a las 2 h; una respuesta rara no lo pisa", async () => {
    let body: unknown = { current: { weather_code: 63, precipitation: 2.4, cloud_cover: 90 } };
    const w = new WeatherStore(async () => body);
    expect(w.now(0)).toBeNull();
    await w.refresh(1000);
    expect(w.now(2000)).toEqual({ sky: "rain", precipitation: 2.4, cloudCover: 90, at: 1000 });
    body = { error: true };
    await expect(w.refresh(3000)).rejects.toThrow();
    expect(w.now(4000)?.sky).toBe("rain");
    expect(w.now(1000 + 2 * 3600_000 + 1)).toBeNull();
  });
});
