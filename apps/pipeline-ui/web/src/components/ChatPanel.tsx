/**
 * Chat panel — composer + live SDK message stream.
 *
 * Renders SDK messages using the same primitives as TranscriptsPanel
 * (see components/MessageRow.tsx) so the two surfaces look identical.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion } from "framer-motion";
import { Loader2, Send, Sparkles, X } from "lucide-react";
import { fetchChatMessages, streamChat, streamChatResume } from "../lib/api";
import { useSSE } from "../lib/sse";
import { useAutoScroll } from "../lib/useAutoScroll";
import {
  MessageRow,
  SystemBanner,
  type SdkOrTranscriptMsg,
} from "./MessageRow";
import { HudCorners } from "./HudFrame";

interface Props {
  projectId: string;
  /** Pipeline to invoke. When null, the chat is freeform without /pipeline:run preface. */
  pipelineName: string | null;
  /** When set, the panel loads this run's persisted chat transcript on mount
   *  and uses streamChatResume for any new prompts the user sends. */
  viewRunId?: string | null;
  /** When set, the panel auto-fires a resume stream for that run on mount
   *  (in addition to loading its transcript). */
  resumeRunId?: string | null;
  onClose: () => void;
  /** Fires when the panel has handled a resumeRunId, so the parent can clear it
   *  and avoid re-firing the resume on re-render. */
  onResumeHandled?: () => void;
  /** Fires when the daemon links a run to an SDK session_id. Used by the
   *  parent to refresh its resumable-runs list. */
  onSessionLinked?: () => void;
}

type Banner = { id: string; text: string; tone: "info" | "error" | "success" };

/** Model picker options. "auto" omits `model` from the request body so the
 *  daemon's resolver picks per PIPELINE.md / step frontmatter. */
type ModelChoice = "auto" | "haiku" | "sonnet" | "opus" | "fable";

interface UserItem {
  id: string;
  kind: "user";
  text: string;
}

interface SdkItem {
  id: string;
  kind: "sdk";
  msg: SdkOrTranscriptMsg;
}

interface BannerItem extends Banner {
  kind: "banner";
}

type ChatItem = UserItem | SdkItem | BannerItem;

function rid(prefix = "m"): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function ChatPanel({
  projectId,
  pipelineName,
  viewRunId,
  resumeRunId,
  onClose,
  onResumeHandled,
  onSessionLinked,
}: Props) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [running, setRunning] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [input, setInput] = useState("");
  const [modelChoice, setModelChoice] = useState<ModelChoice>("auto");
  const cancelRef = useRef<(() => void) | null>(null);
  const { ref: scrollRef, scrollToBottom } = useAutoScroll(items.length);

  useEffect(() => {
    return () => {
      cancelRef.current?.();
    };
  }, []);

  const appendSdk = useCallback((msg: SdkOrTranscriptMsg) => {
    setItems((prev) => [
      ...prev,
      { id: rid("s"), kind: "sdk", msg },
    ]);
  }, []);

  const appendBanner = useCallback(
    (text: string, tone: Banner["tone"] = "info") => {
      setItems((prev) => [
        ...prev,
        { id: rid("b"), kind: "banner", text, tone },
      ]);
    },
    [],
  );

  useEffect(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setItems([]);
    if (!viewRunId) return;
    let cancelled = false;
    fetchChatMessages(projectId, viewRunId)
      .then((messages) => {
        if (cancelled) return;
        for (const msg of messages) appendSdk(msg as SdkOrTranscriptMsg);
      })
      .catch(() => {
        if (cancelled) return;
        appendBanner("Couldn't load this run's chat transcript.", "error");
      });
    return () => {
      cancelled = true;
    };
  }, [viewRunId, projectId, appendSdk, appendBanner]);

  const handleEvent = useCallback(
    (type: string, data: unknown) => {
      const d = (data ?? {}) as Record<string, unknown>;
      if (type === "chat.started" || type === "chat.resumed") {
        setInstalling(false);
        return;
      }
      if (type === "chat.session_linked") {
        onSessionLinked?.();
        return;
      }
      if (type === "chat.error") {
        appendBanner((d.message as string) ?? "Unknown error", "error");
        setRunning(false);
        return;
      }
      if (type === "chat.completed") {
        setRunning(false);
        return;
      }
      if (type === "chat.message") {
        appendSdk(d as SdkOrTranscriptMsg);
      }
    },
    [appendBanner, appendSdk, onSessionLinked],
  );

  useSSE(
    useCallback(
      (msg: { type: string; data: unknown }) => {
        if (msg.type !== "chat.message_part") return;
        if (cancelRef.current) return;
        const d = msg.data as { run_id?: string; msg?: unknown };
        if (!d?.run_id || !viewRunId || d.run_id !== viewRunId) return;
        appendSdk(d.msg as SdkOrTranscriptMsg);
      },
      [viewRunId, appendSdk],
    ),
  );

  const sendPrompt = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || running) return;
      setItems((prev) => [
        ...prev,
        { id: rid("u"), kind: "user", text: trimmed },
      ]);
      setRunning(true);
      setInstalling(true);
      setInput("");
      const modelOverride = modelChoice === "auto" ? undefined : modelChoice;
      const { cancel } = viewRunId
        ? streamChatResume(
            {
              project_id: projectId,
              run_id: viewRunId,
              prompt: trimmed,
              ...(modelOverride ? { model: modelOverride } : {}),
            },
            handleEvent,
          )
        : streamChat(
            {
              project_id: projectId,
              pipeline_name: pipelineName,
              prompt: trimmed,
              ...(modelOverride ? { model: modelOverride } : {}),
            },
            handleEvent,
          );
      cancelRef.current = cancel;
    },
    [running, projectId, pipelineName, viewRunId, handleEvent, modelChoice],
  );

  const stop = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setRunning(false);
    setInstalling(false);
    appendBanner("Stopped.", "info");
  }, [appendBanner]);

  const deferredResumeBannerForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!resumeRunId) {
      deferredResumeBannerForRef.current = null;
      return;
    }
    if (running) {
      if (deferredResumeBannerForRef.current !== resumeRunId) {
        deferredResumeBannerForRef.current = resumeRunId;
        appendBanner(
          `Will resume session ${resumeRunId} after the current stream finishes…`,
          "info",
        );
      }
      return;
    }
    deferredResumeBannerForRef.current = null;
    appendBanner(`Resuming session ${resumeRunId}…`, "info");
    setRunning(true);
    setInstalling(true);
    const { cancel } = streamChatResume(
      { project_id: projectId, run_id: resumeRunId },
      handleEvent,
    );
    cancelRef.current = cancel;
    onResumeHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeRunId, running]);

  const placeholder = useMemo(
    () =>
      pipelineName
        ? `> brief for ${pipelineName}…`
        : "> type a prompt to launch a new Claude Code session…",
    [pipelineName],
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendPrompt(input);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    const ne = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
    if (ne.isComposing || ne.keyCode === 229) return;
    e.preventDefault();
    sendPrompt(input);
  };

  return (
    <motion.div
      key={pipelineName ?? "freeform"}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.22 }}
      className="surface flex h-full min-h-[260px] flex-col overflow-hidden text-accent"
    >
      <HudCorners />
      <header className="flex items-center justify-between gap-3 border-b frame-divider px-5 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-accent">
            <Sparkles size={11} className="text-accent" /> ▌ LAUNCH_SESSION
          </p>
          <h3 className="mt-0.5 truncate font-display text-base font-bold uppercase tracking-[0.12em] text-ink">
            {pipelineName ?? "FREEFORM_PROMPT"}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="border border-transparent p-1 text-muted transition-colors hover:border-accent/60 hover:text-accent"
          aria-label="Close chat"
        >
          <X size={14} />
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={
            pipelineName
              ? `Chat transcript for pipeline ${pipelineName}`
              : "Chat transcript"
          }
          className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-5 py-4"
        >
          {items.length === 0 && (
            <p className="px-2 text-center font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted">
              <span className="caret">// awaiting prompt</span>
              {pipelineName && (
                <span className="block mt-1 normal-case tracking-normal text-muted/80">
                  Spawns Claude Code · pipeline-executor on{" "}
                  <span className="text-accent">{pipelineName}</span>
                </span>
              )}
            </p>
          )}
          {items.map((it) => {
            if (it.kind === "banner") {
              return (
                <div
                  key={it.id}
                  role="status"
                  className="flex justify-center"
                >
                  <SystemBanner text={it.text} tone={it.tone} />
                </div>
              );
            }
            if (it.kind === "user") {
              return (
                <article
                  key={it.id}
                  aria-label="Your message"
                  className="border border-accent2/50 bg-accent2/10 px-3 py-2 font-mono text-[12.5px] text-ink/95"
                >
                  <p className="mb-1 text-[10px] uppercase tracking-[0.22em] text-accent2">
                    <span className="text-accent">▌</span> YOU
                  </p>
                  <p className="whitespace-pre-wrap">{it.text}</p>
                </article>
              );
            }
            return (
              <article key={it.id} aria-label="Assistant message">
                <MessageRow m={it.msg} />
              </article>
            );
          })}

          {(installing || (running && !installing)) && (
            <div
              role="status"
              aria-live="polite"
              className="mt-2 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-wider text-muted"
            >
              <Loader2 size={12} className="animate-spin text-accent" />
              {installing
                ? "LOADING_AGENT_SDK…"
                : "CLAUDE_WORKING…"}
            </div>
          )}
        </div>

        <ScrollToBottomFab onClick={() => scrollToBottom(true)} scrollRef={scrollRef} />
      </div>

      <form
        onSubmit={onSubmit}
        className="border-t frame-divider px-3 py-3"
      >
        <div className="flex flex-col gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            rows={2}
            autoFocus
            className="
              w-full resize-none border border-accent/30 bg-canvas/50 px-3 py-2
              font-mono text-[13px] text-ink placeholder:text-muted/70
              focus:border-accent/80 focus:outline-none focus:ring-1 focus:ring-accent/40
            "
          />
          <div className="flex items-center justify-between gap-2">
            <label
              className="
                flex h-9 items-center gap-1.5 border border-accent/30 bg-canvas/50
                px-2 font-mono text-[10px] uppercase tracking-wider text-muted
              "
              title="auto: honor PIPELINE.md / step frontmatter. haiku|sonnet|opus|fable: pin this chat to that tier."
            >
              <span>MODEL</span>
              <select
                value={modelChoice}
                onChange={(e) => setModelChoice(e.target.value as ModelChoice)}
                aria-label="Model override"
                className="bg-transparent font-mono text-[11px] uppercase text-accent focus:outline-none"
              >
                <option value="auto">AUTO</option>
                <option value="haiku">HAIKU</option>
                <option value="sonnet">SONNET</option>
                <option value="opus">OPUS</option>
                <option value="fable">FABLE</option>
              </select>
            </label>
            {running ? (
              <button
                type="button"
                onClick={stop}
                className="
                  flex h-9 items-center justify-center gap-1.5 border border-bad/60 bg-bad/15
                  px-3 font-mono text-[10.5px] uppercase tracking-[0.18em] text-bad
                  transition-colors hover:bg-bad/25
                "
              >
                <X size={12} /> STOP
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="
                  flex h-9 items-center justify-center gap-1.5 border-2 border-accent
                  bg-canvas/60 px-4 font-mono text-[10.5px] uppercase tracking-[0.18em] text-accent
                  transition-all hover:bg-accent hover:text-canvas
                  disabled:opacity-50 disabled:border-accent/40
                "
              >
                <Send size={12} /> SEND
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 px-1 font-mono text-[9.5px] uppercase tracking-wider text-muted/80">
          PERMS: <code className="bg-panel2 px-1 py-px text-accent">bypassPermissions</code>{" "}
          — agent r/w in this project.
          <span className="ml-2 text-muted/60 normal-case tracking-normal">
            Model <code className="bg-panel2 px-1 py-px text-accent">auto</code> honors PIPELINE.md / step frontmatter.
          </span>
        </p>
      </form>
    </motion.div>
  );
}

function ScrollToBottomFab({
  onClick,
  scrollRef,
}: {
  onClick: () => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
      setShow(!atBottom);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, [scrollRef]);
  if (!show) return null;
  return (
    <button
      onClick={onClick}
      className="
        pointer-events-auto absolute bottom-3 right-4 border border-accent/50 bg-canvas/80
        px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted backdrop-blur
        transition-all hover:border-accent hover:text-accent
      "
      aria-label="Scroll to bottom"
    >
      ↓ BOT
    </button>
  );
}
