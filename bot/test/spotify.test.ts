import { describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { SpotifyStore } from "../src/spotify";
import { readWorks } from "../src/office";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Spotify para el tocadiscos", () => {
  const json = (status: number, body?: unknown) => new Response(body == null ? null : JSON.stringify(body), { status });

  const url = "https://example.com/api/spotify";
  Object.assign(config, { spotifyNowUrl: url });

  test("sin URL del widget no hace nada", async () => {
    Object.assign(config, { spotifyNowUrl: "" });
    try {
      const s = new SpotifyStore(async () => {
        throw new Error("no debería llamar");
      });
      expect(s.enabled).toBe(false);
      await s.refresh();
      expect(s.now()).toBeNull();
    } finally {
      Object.assign(config, { spotifyNowUrl: url });
    }
  });

  test("lee el widget del portfolio, adelanta lo que lleva en caché y lo olvida a los 2 min", async () => {
    let body: unknown = { isPlaying: true, title: "Idol", artist: "YOASOBI", progress: 61_000, duration: 213_000, fetchedAt: 1500 };
    const s = new SpotifyStore(async (u) => {
      expect(u).toBe(url);
      return json(200, body);
    });
    await s.refresh(2000);
    expect(s.now(2000)).toEqual({ playing: true, title: "Idol", artist: "YOASOBI", progressMs: 61_500, durationMs: 213_000, at: 2000 });
    // Parado: el widget da la última canción, pero el tocadiscos solo se entera de que no suena.
    body = { isPlaying: false, title: "Otra", artist: "Alguien" };
    await s.refresh(3000);
    expect(s.now(3000)).toMatchObject({ playing: false, title: "" });
    expect(s.now(3000 + 2 * 60_000 + 1)).toBeNull();
  });

  test("si el widget avisa de un error, no pisa lo último bueno", async () => {
    let body: unknown = { isPlaying: true, title: "Idol", artist: "YOASOBI", progress: 0, duration: 213_000 };
    const s = new SpotifyStore(async () => json(200, body));
    await s.refresh(1000);
    body = { isPlaying: false, error: "Failed to fetch" };
    await expect(s.refresh(2000)).rejects.toThrow("Failed to fetch");
    expect(s.now(2000)?.title).toBe("Idol");
  });
});

describe("obras en la oficina", () => {
  test("un archivo por repo desplegando; los viejos y los nombres raros no cuentan; sin carpeta, nada", () => {
    const dir = mkdtempSync(join(tmpdir(), "obras-"));
    writeFileSync(join(dir, "oficina"), "");
    writeFileSync(join(dir, "honeypot"), "");
    writeFileSync(join(dir, "mal nombre!"), "");
    const old = (Date.now() - 3 * 3600_000) / 1000;
    utimesSync(join(dir, "honeypot"), old, old);
    expect(readWorks(dir).map((w) => w.repo)).toEqual(["oficina"]);
    expect(readWorks(join(dir, "no-existe"))).toEqual([]);
  });
});
