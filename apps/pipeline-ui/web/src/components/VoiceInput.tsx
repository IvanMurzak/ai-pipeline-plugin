import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, MicOff, Square } from "lucide-react";
import { fetchSttStatus } from "../lib/api";
import { transcribeAudio } from "../lib/api";
import { recordingSupported, startRecording, type ActiveRecording } from "../lib/recorder";

// Dictation with two engines, best-first:
//   1. SERVER mode — record with MediaRecorder, transcribe through the
//      daemon's /api/transcribe proxy (Whisper-class quality; available when
//      the user configured OPENAI_API_KEY / GROQ_API_KEY / PIPELINE_STT_URL).
//   2. BROWSER mode — live Web Speech API (Chrome/Edge/Safari built-in),
//      the zero-config fallback.
// Renders nothing when neither engine is available (e.g. Firefox w/o a key).

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: any) => void) | null;
}

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function voiceSupported(): boolean {
  return typeof window !== "undefined" && (getRecognitionCtor() !== null || recordingSupported());
}

// One status probe per page load, shared by every VoiceInput instance.
let sttProbe: Promise<boolean> | null = null;
function serverSttAvailable(): Promise<boolean> {
  if (!sttProbe) {
    sttProbe = fetchSttStatus()
      .then((s) => s.available && recordingSupported())
      .catch(() => false);
  }
  return sttProbe;
}

const LANG_KEY = "pipeline-ui-voice-lang";
// "auto" = no language hint: the server-side Whisper model auto-detects and
// handles MIXED languages in one utterance (Russian + English mid-sentence) —
// a pinned language would transliterate the other half. Browser Web Speech
// can't do that, so "auto" is offered only in server mode; browser mode maps
// it to the navigator's language.
const SERVER_LANGS = ["auto", "ru-RU", "en-US"] as const;
const BROWSER_LANGS = ["ru-RU", "en-US"] as const;

function navigatorLang(): string {
  return navigator.language?.toLowerCase().startsWith("ru") ? "ru-RU" : "en-US";
}

interface Props {
  /** Called with each FINAL transcript chunk (append it to the field). */
  onTranscript: (text: string) => void;
  /** Called with in-flight interim text (browser mode only), '' to clear. */
  onInterim?: (text: string) => void;
  disabled?: boolean;
  className?: string;
}

type Phase = "idle" | "listening" | "recording" | "transcribing";

export function VoiceInput({ onTranscript, onInterim, disabled, className }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [serverMode, setServerMode] = useState<boolean | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [lang, setLang] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(LANG_KEY);
      if (stored) return stored;
    } catch {
      /* ignore */
    }
    // Default to AUTO — the quality (server) engine detects the language per
    // utterance, including mixed-language sentences. Browser fallback maps it
    // to the navigator language at start time.
    return "auto";
  });
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const recorderRef = useRef<ActiveRecording | null>(null);
  const keepAliveRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void serverSttAvailable().then((ok) => {
      if (!cancelled) setServerMode(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  // Clean up on unmount.
  useEffect(
    () => () => {
      keepAliveRef.current = false;
      recRef.current?.abort();
      recorderRef.current?.cancel();
      if (timerRef.current) clearInterval(timerRef.current);
    },
    [],
  );

  if (!voiceSupported()) return null;
  const browserAvailable = getRecognitionCtor() !== null;
  if (serverMode === false && !browserAvailable) return null;

  // ---- SERVER mode (record → whisper) ----
  const startServer = async () => {
    try {
      recorderRef.current = await startRecording();
      setPhase("recording");
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } catch {
      // Mic denied — fall back to browser mode for this session if possible.
      setServerMode(false);
    }
  };
  const stopServer = async () => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    if (!rec) {
      setPhase("idle");
      return;
    }
    setPhase("transcribing");
    try {
      const blob = await rec.stop();
      const text = (await transcribeAudio(blob, lang)).trim();
      if (text) onTranscript(text + " ");
    } catch {
      // Swallow — the field simply doesn't change; the user can retry.
    } finally {
      setPhase("idle");
      setElapsed(0);
    }
  };

  // ---- BROWSER mode (live Web Speech) ----
  const stopBrowser = () => {
    keepAliveRef.current = false;
    recRef.current?.stop();
    setPhase("idle");
    onInterim?.("");
  };
  // The one place the auto→concrete-locale rule lives: Web Speech needs a
  // real locale — "auto" isn't a thing there.
  const browserLang = lang === "auto" ? navigatorLang() : lang;

  const startBrowser = () => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = browserLang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev: any) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const text = res[0]?.transcript ?? "";
        if (res.isFinal) onTranscript(text.trim() ? text.trim() + " " : "");
        else interim += text;
      }
      onInterim?.(interim);
    };
    rec.onerror = () => {
      keepAliveRef.current = false;
      setPhase("idle");
      onInterim?.("");
    };
    rec.onend = () => {
      if (keepAliveRef.current) {
        try {
          rec.start();
          return;
        } catch {
          /* fall through */
        }
      }
      setPhase("idle");
      onInterim?.("");
    };
    recRef.current = rec;
    keepAliveRef.current = true;
    try {
      rec.start();
      setPhase("listening");
    } catch {
      keepAliveRef.current = false;
    }
  };

  const useServer = serverMode === true;
  const active = phase === "recording" || phase === "listening";
  const onClick = () => {
    if (phase === "transcribing") return;
    if (useServer) {
      if (phase === "recording") void stopServer();
      else void startServer();
    } else {
      if (phase === "listening") stopBrowser();
      else startBrowser();
    }
  };

  const title =
    phase === "recording"
      ? "Stop recording — the audio is then transcribed"
      : phase === "listening"
      ? "Stop dictation"
      : phase === "transcribing"
      ? "Transcribing…"
      : useServer
      ? `Record & transcribe (${lang === "auto" ? "language auto-detect, mixed OK" : lang}, server model)`
      : `Dictate (${browserLang}, browser engine — ONE language at a time)`;

  const langs: readonly string[] = useServer ? SERVER_LANGS : BROWSER_LANGS;
  const cycleLang = () => {
    const idx = langs.indexOf(lang);
    setLang(langs[(idx + 1) % langs.length]);
  };
  const langLabel = useServer && lang === "auto" ? "AUTO" : browserLang.slice(0, 2);

  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
      <button
        type="button"
        disabled={disabled || phase === "transcribing" || serverMode === null}
        onClick={onClick}
        title={title}
        aria-pressed={active}
        className={`relative grid h-8 min-w-8 place-items-center border px-1 transition-colors ${
          active
            ? "border-bad bg-bad/15 text-bad animate-pulse"
            : phase === "transcribing"
            ? "border-warn/60 text-warn"
            : "border-accent/40 text-accent hover:bg-accent/10"
        } disabled:opacity-40`}
      >
        {phase === "transcribing" ? (
          <Loader2 size={14} className="animate-spin" />
        ) : phase === "recording" ? (
          <span className="flex items-center gap-1 px-0.5">
            <Square size={11} fill="currentColor" />
            <span className="font-mono text-[9px] tabular-nums">{elapsed}s</span>
          </span>
        ) : phase === "listening" ? (
          <MicOff size={14} />
        ) : (
          <Mic size={14} />
        )}
      </button>
      <button
        type="button"
        disabled={disabled || active || phase === "transcribing"}
        onClick={cycleLang}
        title={
          useServer
            ? "Dictation language — AUTO detects per utterance and handles mixed Russian+English"
            : "Dictation language. BROWSER ENGINE: one language at a time, no mixed speech — configure a server transcription key (GROQ_API_KEY / OPENAI_API_KEY / PIPELINE_STT_URL) for Whisper-quality multilingual dictation."
        }
        className={
          useServer
            ? "border border-accent/25 px-1 py-0.5 font-mono text-[9px] uppercase tracking-widest text-muted hover:text-accent disabled:opacity-40"
            : "border border-warn/50 px-1 py-0.5 font-mono text-[9px] uppercase tracking-widest text-warn hover:bg-warn/10 disabled:opacity-40"
        }
      >
        {langLabel}
        {!useServer && "!"}
      </button>
    </span>
  );
}
