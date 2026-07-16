/**
 * Speech-to-text proxy — provider resolution (pure) + the HTTP handler against
 * a stub OpenAI-compatible endpoint (a throwaway Bun server).
 *
 *   bun test tests/transcribe.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { handleTranscribe, handleTranscribeStatus, resolveSttProvider } from "../transcribe";

describe("resolveSttProvider", () => {
  test("no keys → null; single keys pick their provider + default model", () => {
    expect(resolveSttProvider({})).toBeNull();
    expect(resolveSttProvider({ OPENAI_API_KEY: "sk-x" })).toEqual({
      provider: "openai",
      url: "https://api.openai.com/v1/audio/transcriptions",
      key: "sk-x",
      model: "whisper-1",
    });
    expect(resolveSttProvider({ GROQ_API_KEY: "gsk-x" })?.model).toBe("whisper-large-v3-turbo");
    expect(resolveSttProvider({ PIPELINE_STT_URL: "http://localhost:9999/v1/audio/transcriptions" })).toEqual({
      provider: "custom",
      url: "http://localhost:9999/v1/audio/transcriptions",
      key: null,
      model: "whisper-1",
    });
  });

  test("precedence custom > openai > groq; PIPELINE_STT_PROVIDER forces; _MODEL overrides", () => {
    const env = {
      PIPELINE_STT_URL: "http://x/v1",
      OPENAI_API_KEY: "sk",
      GROQ_API_KEY: "gsk",
    };
    expect(resolveSttProvider(env)?.provider).toBe("custom");
    expect(resolveSttProvider({ ...env, PIPELINE_STT_PROVIDER: "groq" })?.provider).toBe("groq");
    expect(resolveSttProvider({ ...env, PIPELINE_STT_PROVIDER: "openai" })?.provider).toBe("openai");
    expect(resolveSttProvider({ OPENAI_API_KEY: "sk", PIPELINE_STT_MODEL: "whisper-large" })?.model).toBe(
      "whisper-large",
    );
    // Forcing a provider whose key is absent → null (honest unavailability).
    expect(resolveSttProvider({ OPENAI_API_KEY: "sk", PIPELINE_STT_PROVIDER: "groq" })).toBeNull();
  });

  test("status endpoint mirrors resolution", async () => {
    const on = handleTranscribeStatus({ OPENAI_API_KEY: "sk" } as Record<string, string | undefined>);
    expect(await on.json()).toEqual({ available: true, provider: "openai", model: "whisper-1" });
    const off = handleTranscribeStatus({} as Record<string, string | undefined>);
    expect(((await off.json()) as { available: boolean }).available).toBe(false);
  });
});

describe("handleTranscribe against a stub provider", () => {
  let seen: { auth: string | null; model: string | null; language: string | null; filename: string | null } | null =
    null;
  const stub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const form = await req.formData();
      const file = form.get("file") as File | null;
      seen = {
        auth: req.headers.get("authorization"),
        model: (form.get("model") as string | null) ?? null,
        language: (form.get("language") as string | null) ?? null,
        filename: file?.name ?? null,
      };
      return Response.json({ text: "  привет из виспера  " });
    },
  });
  const env = {
    PIPELINE_STT_URL: `http://127.0.0.1:${stub.port}/v1/audio/transcriptions`,
    PIPELINE_STT_KEY: "local-secret",
    PIPELINE_STT_MODEL: "whisper-large-v3",
  };
  afterAll(() => stub.stop(true));

  test("forwards audio as multipart, maps lang ru-RU→ru, trims the text", async () => {
    const req = new Request("http://x/api/transcribe?lang=ru-RU", {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    const res = await handleTranscribe(req, new URL(req.url), env);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ text: "привет из виспера", provider: "custom", model: "whisper-large-v3" });
    expect(seen).toEqual({
      auth: "Bearer local-secret",
      model: "whisper-large-v3",
      language: "ru",
      filename: "audio.webm",
    });
  });

  test("lang=auto sends NO language hint — Whisper auto-detects (mixed ru+en)", async () => {
    const req = new Request("http://x/api/transcribe?lang=auto", {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    const res = await handleTranscribe(req, new URL(req.url), env);
    expect(res.ok).toBe(true);
    expect(seen?.language).toBeNull();
  });

  test("empty body → 400; no provider → 503", async () => {
    const empty = new Request("http://x/api/transcribe", { method: "POST", body: new Uint8Array(0) });
    expect((await handleTranscribe(empty, new URL(empty.url), env)).status).toBe(400);
    const noProv = new Request("http://x/api/transcribe", { method: "POST", body: new Uint8Array([1]) });
    expect((await handleTranscribe(noProv, new URL(noProv.url), {})).status).toBe(503);
  });

  test("provider failure → 502 with detail", async () => {
    const badEnv = { PIPELINE_STT_URL: "http://127.0.0.1:1/nope" };
    const req = new Request("http://x/api/transcribe", { method: "POST", body: new Uint8Array([1]) });
    const res = await handleTranscribe(req, new URL(req.url), badEnv);
    expect(res.status).toBe(502);
  });
});
