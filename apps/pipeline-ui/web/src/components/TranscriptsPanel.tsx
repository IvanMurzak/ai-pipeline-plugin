import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDown,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Layers,
  Loader2,
  RefreshCw,
  ScrollText,
} from "lucide-react";
import {
  fetchTranscript,
  fetchTranscripts,
  type TranscriptBody,
  type TranscriptEntry,
} from "../lib/api";
import { relativeTime } from "../lib/format";
import { useAutoScroll } from "../lib/useAutoScroll";
import { MessageRow, type SdkOrTranscriptMsg } from "./MessageRow";
import { HudCorners } from "./HudFrame";

interface Props {
  projectId: string;
}

const AUTO_REFRESH_MS = 4000;

export function TranscriptsPanel({ projectId }: Props) {
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [body, setBody] = useState<TranscriptBody | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingBody, setLoadingBody] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const reloadList = useCallback(() => {
    setLoadingList(true);
    fetchTranscripts(projectId)
      .then(({ transcripts: t, total }) => {
        setTranscripts(t);
        setTotal(total);
        setError(null);
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoadingList(false));
  }, [projectId]);

  useEffect(() => {
    reloadList();
  }, [reloadList]);

  useEffect(() => {
    setSelectedId(null);
    setBody(null);
    setError(null);
  }, [projectId]);

  useEffect(() => {
    if (!autoRefresh) {
      if (tickRef.current) clearInterval(tickRef.current);
      return;
    }
    tickRef.current = setInterval(() => {
      reloadList();
      if (selectedId) reloadBody(selectedId);
    }, AUTO_REFRESH_MS);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, reloadList, selectedId]);

  const reloadBody = useCallback(
    (id: string) => {
      setLoadingBody(true);
      fetchTranscript(projectId, id)
        .then((b) => {
          setBody(b);
          setError(null);
        })
        .catch((e) => setError(String(e?.message ?? e)))
        .finally(() => setLoadingBody(false));
    },
    [projectId],
  );

  useEffect(() => {
    if (!selectedId) {
      setBody(null);
      return;
    }
    reloadBody(selectedId);
  }, [selectedId, reloadBody]);

  const msgCount = body?.messages.length ?? 0;
  const { ref: scrollRef, scrollToBottom } = useAutoScroll(msgCount);

  return (
    <div className="surface flex h-full flex-col overflow-hidden text-accent2">
      <HudCorners />
      <header className="flex items-center justify-between gap-3 border-b frame-divider px-5 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-accent2">
            <ScrollText size={11} className="text-accent2" /> ▌ TRANSCRIPTS
          </p>
          <h3 className="mt-0.5 truncate font-display text-base font-bold uppercase tracking-[0.12em] text-ink">
            CLAUDE_CODE_ACTIVITY
          </h3>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors ${
              autoRefresh
                ? "border-good/60 bg-good/10 text-good"
                : "border-line/40 bg-panel2/50 text-muted hover:text-ink"
            }`}
            title={autoRefresh ? "Live mode is on" : "Live mode is off"}
          >
            {autoRefresh ? "LIVE" : "PAUSED"}
          </button>
          <button
            onClick={() => {
              reloadList();
              if (selectedId) reloadBody(selectedId);
            }}
            className="border border-transparent p-1 text-muted transition-colors hover:border-accent2/60 hover:text-accent2"
            aria-label="Refresh"
            disabled={loadingList}
          >
            <RefreshCw size={13} className={loadingList ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      <Picker
        transcripts={transcripts}
        total={total}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="absolute inset-0 overflow-y-auto px-5 py-3"
        >
          {error && (
            <div className="border border-bad/60 bg-bad/10 px-3 py-2 font-mono text-[11px] text-bad">
              {error}
            </div>
          )}
          {!selectedId && !error && (
            <p className="px-2 text-center font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted">
              <span className="caret">// pick a session above</span>
            </p>
          )}
          {selectedId && loadingBody && !body && (
            <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-wider text-muted">
              <Loader2 size={12} className="animate-spin text-accent" /> READING_TRANSCRIPT…
            </div>
          )}
          {body && <TranscriptContent body={body} />}
        </div>
        {body && msgCount > 0 && (
          <ScrollToBottomButton onClick={() => scrollToBottom(true)} scrollRef={scrollRef} />
        )}
      </div>
    </div>
  );
}

function ScrollToBottomButton({
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
        p-2 text-muted backdrop-blur transition-all hover:border-accent hover:text-accent
      "
      aria-label="Scroll to bottom"
    >
      <ArrowDown size={13} />
    </button>
  );
}

function Picker({
  transcripts,
  total,
  selectedId,
  onSelect,
}: {
  transcripts: TranscriptEntry[];
  total: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => transcripts.find((t) => t.id === selectedId) ?? null,
    [transcripts, selectedId],
  );
  return (
    <div className="border-b frame-divider bg-panel2/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-5 py-2.5 text-left font-mono transition-colors hover:bg-panel2/60"
      >
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink/90">
          {selected ? (
            <SelectedSummary entry={selected} />
          ) : (
            <span className="text-muted uppercase tracking-[0.18em]">
              SELECT_SESSION…{" "}
              <span className="text-[10px] text-muted/70 normal-case tracking-normal">
                ({transcripts.length}
                {total > transcripts.length ? ` of ${total}` : ""})
              </span>
            </span>
          )}
        </span>
        {open ? (
          <ChevronDown size={13} className="text-accent/70" />
        ) : (
          <ChevronRight size={13} className="text-accent/70" />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="max-h-60 overflow-y-auto font-mono"
          >
            {transcripts.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => {
                    onSelect(t.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 px-5 py-1.5 text-left text-[11px] transition-colors hover:bg-panel2/70 ${
                    t.id === selectedId ? "bg-accent/10 text-accent" : "text-ink/85"
                  }`}
                >
                  <KindIcon kind={t.kind} />
                  <span className="min-w-0 flex-1 truncate">
                    {t.kind === "subagent"
                      ? `${t.session_id.slice(0, 8)}/${t.subagent_id?.slice(0, 12) ?? "?"}`
                      : t.session_id}
                  </span>
                  <span className="shrink-0 text-[9.5px] uppercase tracking-wider text-muted">
                    {relativeTime(t.modified_at)}
                  </span>
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

function SelectedSummary({ entry }: { entry: TranscriptEntry }) {
  return (
    <span className="flex items-center gap-2">
      <KindIcon kind={entry.kind} />
      <span className="truncate">
        {entry.kind === "subagent"
          ? `${entry.session_id.slice(0, 8)}/${entry.subagent_id?.slice(0, 12) ?? "?"}`
          : entry.session_id}
      </span>
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted">
        <Clock size={9} className="mb-px inline" /> {relativeTime(entry.modified_at)}
      </span>
    </span>
  );
}

function KindIcon({ kind }: { kind: "session" | "subagent" }) {
  return kind === "session" ? (
    <FileText size={12} className="shrink-0 text-accent" />
  ) : (
    <Layers size={12} className="shrink-0 text-accent2" />
  );
}

function TranscriptContent({ body }: { body: TranscriptBody }) {
  const msgs = body.messages as SdkOrTranscriptMsg[];
  return (
    <div className="space-y-2.5">
      {body.truncated && (
        <p className="border border-line/40 bg-panel2/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted">
          ◇ TAIL_VIEW — earlier turns truncated.
        </p>
      )}
      {msgs.map((m, i) => (
        <MessageRow key={m.uuid ?? i} m={m} />
      ))}
      {msgs.length === 0 && (
        <p className="text-center font-mono text-[10.5px] uppercase tracking-wider text-muted">
          // no messages in this transcript yet
        </p>
      )}
    </div>
  );
}
