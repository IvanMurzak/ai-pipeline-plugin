// Speech-to-text proxy — quality dictation for the dashboard.
//
// The browser records audio (MediaRecorder) and posts it here; the daemon
// forwards it to an OpenAI-compatible transcription endpoint and returns the
// text. This keeps API keys OUT of the browser and lets the same UI work with
// any provider:
//
//   provider resolution (first match wins):
//     PIPELINE_STT_URL          — custom OpenAI-compatible /v1/audio/transcriptions
//                                 endpoint (e.g. a local whisper server);
//                                 PIPELINE_STT_KEY optional, PIPELINE_STT_MODEL
//                                 (default whisper-1)
//     OPENAI_API_KEY            — api.openai.com, model whisper-1
//                                 (PIPELINE_STT_MODEL overrides)
//     GROQ_API_KEY              — api.groq.com,  model whisper-large-v3-turbo
//                                 (PIPELINE_STT_MODEL overrides)
//     PIPELINE_STT_PROVIDER     — force "openai" | "groq" | "custom" when several
//                                 keys are present
//     none                      — {available:false}; the web VoiceInput falls
//                                 back to the browser's own Web Speech API
//
// Endpoints (wired into server.ts handleApi):
//   GET  /api/transcribe/status → { available, provider, model }
//   POST /api/transcribe?lang=ru — raw audio body (webm/ogg/mp4/wav) → { text }
//
// PRIVACY: audio leaves the machine ONLY when the user configured a cloud
// provider key, and only to that provider. Nothing is persisted server-side.

const MAX_AUDIO_BYTES = 20_000_000;

export interface SttProvider {
  provider: "openai" | "groq" | "custom";
  url: string;
  key: string | null;
  model: string;
}

export function resolveSttProvider(env: Record<string, string | undefined>): SttProvider | null {
  const forced = (env.PIPELINE_STT_PROVIDER ?? "").trim().toLowerCase();
  const custom: SttProvider | null = env.PIPELINE_STT_URL?.trim()
    ? {
        provider: "custom",
        url: env.PIPELINE_STT_URL.trim(),
        key: env.PIPELINE_STT_KEY?.trim() || null,
        model: env.PIPELINE_STT_MODEL?.trim() || "whisper-1",
      }
    : null;
  const openai: SttProvider | null = env.OPENAI_API_KEY?.trim()
    ? {
        provider: "openai",
        url: "https://api.openai.com/v1/audio/transcriptions",
        key: env.OPENAI_API_KEY.trim(),
        model: env.PIPELINE_STT_MODEL?.trim() || "whisper-1",
      }
    : null;
  const groq: SttProvider | null = env.GROQ_API_KEY?.trim()
    ? {
        provider: "groq",
        url: "https://api.groq.com/openai/v1/audio/transcriptions",
        key: env.GROQ_API_KEY.trim(),
        model: env.PIPELINE_STT_MODEL?.trim() || "whisper-large-v3-turbo",
      }
    : null;
  if (forced === "custom") return custom;
  if (forced === "openai") return openai;
  if (forced === "groq") return groq;
  return custom ?? openai ?? groq;
}

export function handleTranscribeStatus(env: Record<string, string | undefined> = process.env): Response {
  const p = resolveSttProvider(env);
  return Response.json(
    p ? { available: true, provider: p.provider, model: p.model } : { available: false, provider: null, model: null },
  );
}

/** Map the recorded blob's MIME to a filename the providers accept. */
function filenameFor(contentType: string): string {
  const t = contentType.toLowerCase();
  if (t.includes("ogg")) return "audio.ogg";
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return "audio.mp4";
  if (t.includes("wav")) return "audio.wav";
  if (t.includes("mpeg") || t.includes("mp3")) return "audio.mp3";
  return "audio.webm";
}

export async function handleTranscribe(
  req: Request,
  url: URL,
  env: Record<string, string | undefined> = process.env,
): Promise<Response> {
  const p = resolveSttProvider(env);
  if (!p) {
    return new Response("no transcription provider configured (set OPENAI_API_KEY, GROQ_API_KEY, or PIPELINE_STT_URL)", {
      status: 503,
    });
  }
  let audio: ArrayBuffer;
  try {
    audio = await req.arrayBuffer();
  } catch (e) {
    return new Response(`bad audio body: ${e}`, { status: 400 });
  }
  if (audio.byteLength === 0) return new Response("empty audio body", { status: 400 });
  if (audio.byteLength > MAX_AUDIO_BYTES) return new Response("audio too large (20MB cap)", { status: 413 });

  const contentType = req.headers.get("content-type") ?? "audio/webm";
  const form = new FormData();
  form.append("file", new Blob([audio], { type: contentType }), filenameFor(contentType));
  form.append("model", p.model);
  form.append("response_format", "json");
  const lang = url.searchParams.get("lang");
  // Whisper takes ISO-639-1 ("ru"), not a BCP-47 locale ("ru-RU"). "auto"
  // (or absent) sends NO language hint — Whisper then auto-detects, which is
  // what makes mixed-language dictation (Russian + English in one sentence)
  // come out right; a forced "en" would transliterate the Russian half.
  if (lang && lang.toLowerCase() !== "auto") form.append("language", lang.slice(0, 2).toLowerCase());

  let upstream: Response;
  try {
    upstream = await fetch(p.url, {
      method: "POST",
      headers: p.key ? { Authorization: `Bearer ${p.key}` } : {},
      body: form,
    });
  } catch (e) {
    return new Response(`transcription provider unreachable: ${e}`, { status: 502 });
  }
  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => "")).slice(0, 400);
    return new Response(`transcription failed (${upstream.status}): ${detail}`, { status: 502 });
  }
  try {
    const j = (await upstream.json()) as { text?: unknown };
    const text = typeof j.text === "string" ? j.text.trim() : "";
    return Response.json({ text, provider: p.provider, model: p.model });
  } catch (e) {
    return new Response(`transcription response unparseable: ${e}`, { status: 502 });
  }
}
