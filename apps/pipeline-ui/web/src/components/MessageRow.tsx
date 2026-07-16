/**
 * Shared message renderer for Claude SDK / Claude Code transcripts.
 *
 * Both TranscriptsPanel and ChatPanel surface the same kind of content
 * (an SDK message stream with assistant/user/system/tool_use/tool_result/
 * thinking blocks). Before this module they had two divergent renderers,
 * which is how the chat ended up "too simple" compared to transcripts.
 *
 * Input shapes accepted:
 *   - Claude Code transcript files (`{type, message:{role, content:[...]}}`)
 *   - Anthropic Agent SDK live stream messages (`{type:"assistant", message:{content:[...]}}`, `{type:"result", ...}`, `{type:"system", subtype:"init", ...}`)
 *
 * The two are unified here — every renderer below handles "best effort"
 * extraction so the same component renders both equally well.
 */

import { useMemo } from "react";
import { Hammer } from "lucide-react";
import { Markdown } from "./Markdown";
import { relativeTime } from "../lib/format";

export type SdkOrTranscriptMsg = {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  /** assistant-ui's `result` carries usage at the top level. */
  result?: string;
  usage?: Record<string, number>;
  is_error?: boolean;
  /** assistant-ui's `subagent_type` survives on the parent message. */
  subagent_type?: string;
  /** Set to "mirror" when this row was captured from a Claude Code
   *  terminal session by the daemon's MirrorService (issue #11). The
   *  chat panel uses this to render a tiny "from terminal" tag so the
   *  user knows the message did not come from the in-browser /api/chat
   *  flow. SDK-originated rows omit this field. */
  source?: "mirror" | "sdk";
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
      id?: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
      thinking?: string;
    }>;
  };
  /** Some transcript variants stuff a one-liner here. */
  summary?: string;
};

interface Props {
  m: SdkOrTranscriptMsg;
}

export function MessageRow({ m }: Props) {
  // SDK init carries `type: "system", subtype: "init"` — render as a tiny
  // banner so the user sees "session ready" instead of nothing.
  if (m.type === "system" && m.subtype === "init") {
    return <SystemBanner text="◉ Claude session ready" />;
  }
  // Live SDK `result` — render the result text plus usage stats.
  if (m.type === "result") {
    return <ResultRow text={m.result ?? "Done."} usage={m.usage} isError={m.is_error} />;
  }
  // Live SDK assistant message OR transcript assistant message.
  const role = m.message?.role ?? m.type;
  if (role === "assistant") return <AssistantRow m={m} />;
  if (role === "user") return <UserRow m={m} />;
  if (role === "system" || m.type === "summary") return <SystemRow m={m} />;
  return null;
}

// --------------------------------------------------------------------
// Assistant
// --------------------------------------------------------------------

function AssistantRow({ m }: { m: SdkOrTranscriptMsg }) {
  const content = m.message?.content ?? [];
  return (
    <div className="border border-accent/25 bg-panel/55 px-3 py-2 font-mono">
      <p className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.22em] text-accent">
        <span className="text-accent2">▌</span> ASSISTANT
        {m.subagent_type && (
          <span className="border border-accent/50 px-1.5 py-px text-[9.5px] tracking-wider text-accent/90">
            {m.subagent_type}
          </span>
        )}
        {m.source === "mirror" && (
          <span
            className="border border-muted/40 px-1.5 py-px text-[9.5px] tracking-wider text-muted/80"
            title="Captured from a Claude Code terminal session"
          >
            terminal
          </span>
        )}
        {m.timestamp && (
          <span className="text-[9.5px] normal-case tracking-wider text-muted">
            · {relativeTime(m.timestamp)}
          </span>
        )}
      </p>
      <div className="space-y-1.5">
        {content.map((c, i) => {
          if (c.type === "text" && c.text) {
            return (
              <div key={i} className="text-[12.5px] text-ink/90">
                <Markdown size="sm">{c.text}</Markdown>
              </div>
            );
          }
          if (c.type === "tool_use") {
            return (
              <ToolUseBlock
                key={i}
                name={c.name ?? "tool"}
                input={c.input}
              />
            );
          }
          if (c.type === "thinking") {
            const text = c.thinking ?? "";
            return (
              <details key={i} className="text-[11.5px] text-muted">
                <summary className="cursor-pointer uppercase tracking-wider">
                  ⟡ THINKING ({text.length})
                </summary>
                <pre className="mt-1 whitespace-pre-wrap text-[10.5px]">
                  {text}
                </pre>
              </details>
            );
          }
          return null;
        })}
        {content.length === 0 && (
          <p className="text-[10.5px] uppercase tracking-wider text-muted">// empty turn</p>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------
// User
// --------------------------------------------------------------------

function UserRow({ m }: { m: SdkOrTranscriptMsg }) {
  const content = m.message?.content;
  if (Array.isArray(content)) {
    const toolResults = content.filter((c) => c.type === "tool_result");
    const text = content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
    if (text || toolResults.length > 0) {
      return (
        <div className="space-y-1.5">
          {text && <UserTextBubble text={text} />}
          {toolResults.length > 0 && (
            <div className="ml-3 space-y-1.5">
              {toolResults.map((tr, i) => (
                <ToolResultBlock
                  key={i}
                  isError={tr.is_error}
                  content={tr.content}
                />
              ))}
            </div>
          )}
        </div>
      );
    }
  } else if (typeof content === "string") {
    return <UserTextBubble text={content} />;
  }
  return null;
}

function UserTextBubble({ text }: { text: string }) {
  return (
    <div className="border border-accent2/50 bg-accent2/10 px-3 py-2 font-mono text-[12.5px] text-ink/95">
      <p className="mb-1 text-[10px] uppercase tracking-[0.22em] text-accent2">
        <span className="text-accent">▌</span> USER
      </p>
      <Markdown size="sm">{text}</Markdown>
    </div>
  );
}

// --------------------------------------------------------------------
// System / summary / banner
// --------------------------------------------------------------------

function SystemRow({ m }: { m: SdkOrTranscriptMsg }) {
  const text =
    (m.message?.content?.[0] as { text?: string } | undefined)?.text ??
    m.summary ??
    "";
  if (!text) return null;
  return (
    <p className="text-center font-mono text-[10.5px] italic uppercase tracking-wider text-muted">
      {text.length > 200 ? text.slice(0, 200) + "…" : text}
    </p>
  );
}

export function SystemBanner({
  text,
  tone = "info",
}: {
  text: string;
  tone?: "info" | "error" | "success";
}) {
  const ring =
    tone === "error"
      ? "border-bad/60 bg-bad/10 text-bad"
      : tone === "success"
        ? "border-good/60 bg-good/10 text-good"
        : "border-line/50 bg-panel2/40 text-muted";
  return (
    <p
      className={`
        mx-auto my-1.5 inline-flex items-center justify-center self-center border px-3 py-0.5
        font-mono text-[10.5px] uppercase tracking-[0.16em] ${ring}
      `}
    >
      {text}
    </p>
  );
}

// --------------------------------------------------------------------
// Result
// --------------------------------------------------------------------

function ResultRow({
  text,
  usage,
  isError,
}: {
  text: string;
  usage?: Record<string, number>;
  isError?: boolean;
}) {
  return (
    <div
      className={`border px-3 py-2 font-mono ${
        isError
          ? "border-bad/60 bg-bad/10"
          : "border-good/60 bg-good/10"
      }`}
    >
      <p
        className={`mb-1 text-[10px] uppercase tracking-[0.22em] ${
          isError ? "text-bad" : "text-good"
        }`}
      >
        <span className="text-accent">▌</span> {isError ? "ERRORED" : "RESULT"}
      </p>
      <div className="text-[12.5px] text-ink/90">
        <Markdown size="sm">{text}</Markdown>
      </div>
      {usage && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-[9.5px] uppercase tracking-wider text-muted">
          {Object.entries(usage).map(([k, v]) => (
            <span key={k}>
              {k.replace(/_/g, " ")}: <span className="tabular-nums text-ink/80">{v}</span>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

// --------------------------------------------------------------------
// Tool use / tool result expandables
// --------------------------------------------------------------------

export function ToolUseBlock({ name, input }: { name: string; input?: unknown }) {
  const argText = useMemo(() => {
    if (!input) return "";
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }, [input]);
  return (
    <details className="border border-warn/30 bg-panel2/40 px-2 py-1 font-mono text-[11px] text-muted">
      <summary className="flex cursor-pointer items-center gap-1.5 uppercase tracking-wider">
        <Hammer size={11} className="text-warn" /> {name}
      </summary>
      {argText && (
        <pre className="mt-1.5 max-h-48 overflow-x-auto whitespace-pre-wrap text-[10.5px] text-ink/80">
          {argText.slice(0, 1200)}
          {argText.length > 1200 ? "\n[…truncated]" : ""}
        </pre>
      )}
    </details>
  );
}

export function ToolResultBlock({
  isError,
  content,
}: {
  isError?: boolean;
  content?: unknown;
}) {
  const text = useMemo(() => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c: { type?: string; text?: string }) =>
          c.type === "text" ? (c.text ?? "") : "",
        )
        .join("\n");
    }
    return JSON.stringify(content, null, 2) ?? "(no content)";
  }, [content]);
  return (
    <details
      className={`border px-2 py-1 font-mono text-[10.5px] ${
        isError
          ? "border-bad/50 bg-bad/10 text-bad"
          : "border-line/40 bg-panel2/40 text-muted"
      }`}
    >
      <summary className="cursor-pointer uppercase tracking-wider">
        {isError ? "TOOL_RESULT (ERROR)" : "TOOL_RESULT"} · {text.length}
      </summary>
      <pre className="mt-1 max-h-56 overflow-x-auto whitespace-pre-wrap text-ink/80">
        {text.slice(0, 1600)}
        {text.length > 1600 ? "\n[…truncated]" : ""}
      </pre>
    </details>
  );
}
