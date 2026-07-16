import { useState } from "react";
import { CircleHelp, Loader2, Send } from "lucide-react";
import { motion } from "framer-motion";
import { answerRun } from "../lib/api";
import { VoiceInput } from "./VoiceInput";
import { appendDictation, withInterim } from "../lib/format";
import type { DriveRunSnapshot } from "../types";

interface Props {
  projectId: string;
  run: DriveRunSnapshot;
  /** Called after the answer was accepted (the run resumes). */
  onAnswered: () => void;
}

/** The needs-input banner: a daemon-launched run parked on a question. The
 *  answer resumes the SAME executor session (its transcript survives on
 *  disk), so the step continues where it stopped instead of starting over. */
export function AwaitingInput({ projectId, run, onAnswered }: Props) {
  const [answer, setAnswer] = useState("");
  const [interim, setInterim] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = run.question;
  if (!q) return null;

  const send = async (text: string) => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await answerRun(projectId, run.run_id, text.trim());
      setAnswer("");
      onAnswered();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSending(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="surface border-2 border-warn/60 p-3 sm:p-4"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center border border-warn/50 text-warn">
          <CircleHelp size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-warn">
            Run is waiting for your answer
          </div>
          <p className="mt-1 text-sm leading-snug text-ink">{q.text}</p>
          {q.context && <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{q.context}</p>}
        </div>
      </div>

      {q.options && q.options.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {q.options.map((opt) => (
            <button
              key={opt}
              type="button"
              disabled={sending}
              onClick={() => void send(opt)}
              className="min-h-[36px] border border-warn/50 px-3 py-1.5 font-mono text-xs text-warn transition-colors hover:bg-warn/15 disabled:opacity-40"
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-end gap-2">
        <textarea
          value={withInterim(answer, interim)}
          onChange={(e) => {
            setAnswer(e.target.value);
            setInterim("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(answer);
            }
          }}
          rows={2}
          placeholder="Type or dictate your answer…"
          className="min-h-[44px] w-full resize-y border border-accent/30 bg-panel2 p-2.5 text-xs leading-relaxed text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none"
        />
        <VoiceInput
          onTranscript={(t) => setAnswer((prev) => appendDictation(prev, t))}
          onInterim={setInterim}
          disabled={sending}
        />
        <button
          type="button"
          disabled={sending || !answer.trim()}
          onClick={() => void send(answer)}
          title="Send answer (Enter)"
          className="grid h-11 w-11 shrink-0 place-items-center border-2 border-accent text-accent transition-colors hover:bg-accent/15 disabled:opacity-40"
        >
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </div>
      {error && <div className="mt-2 text-[11px] text-bad">{error}</div>}
    </motion.div>
  );
}
