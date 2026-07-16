import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  children: string;
  /** Size preset — controls headings/font scale. */
  size?: "sm" | "md";
  /** Optional className appended to the wrapper. */
  className?: string;
}

// Shared renderer for our themed markdown. One place to tune typography for
// every place we surface a markdown blob (step bodies, pipeline manifest
// excerpts, halt reasons, etc.). Built on react-markdown so adding plugins
// later (math, mermaid, footnotes) is a one-import change.
export function Markdown({ children, size = "md", className }: Props) {
  const components = useMemo<Components>(
    () => ({
      h1: ({ node, ...p }) => (
        <h1
          {...p}
          className={`mt-2 text-base font-semibold text-ink ${size === "sm" ? "text-[15px]" : ""}`}
        />
      ),
      h2: ({ node, ...p }) => (
        <h2 {...p} className="mt-3 text-[14.5px] font-semibold text-ink" />
      ),
      h3: ({ node, ...p }) => (
        <h3 {...p} className="mt-2 text-[13.5px] font-semibold text-ink" />
      ),
      h4: ({ node, ...p }) => (
        <h4 {...p} className="mt-2 text-[13px] font-semibold text-ink" />
      ),
      p: ({ node, ...p }) => (
        <p
          {...p}
          className={`my-1.5 leading-relaxed text-ink/90 ${
            size === "sm" ? "text-[12.5px]" : "text-[13px]"
          }`}
        />
      ),
      strong: ({ node, ...p }) => (
        <strong {...p} className="font-semibold text-ink" />
      ),
      em: ({ node, ...p }) => <em {...p} className="italic text-ink/90" />,
      del: ({ node, ...p }) => (
        <del {...p} className="text-muted line-through" />
      ),
      a: ({ node, href, ...p }) => (
        <a
          {...p}
          href={href}
          target={href?.startsWith("http") ? "_blank" : undefined}
          rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
          className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        />
      ),
      ul: ({ node, ...p }) => (
        <ul
          {...p}
          className={`my-1.5 list-disc space-y-1 pl-5 marker:text-muted ${
            size === "sm" ? "text-[12.5px]" : "text-[13px]"
          }`}
        />
      ),
      ol: ({ node, ...p }) => (
        <ol
          {...p}
          className={`my-1.5 list-decimal space-y-1 pl-5 marker:text-muted ${
            size === "sm" ? "text-[12.5px]" : "text-[13px]"
          }`}
        />
      ),
      li: ({ node, ...p }) => (
        <li {...p} className="leading-relaxed text-ink/90" />
      ),
      blockquote: ({ node, ...p }) => (
        <blockquote
          {...p}
          className="my-2 border-l-2 border-accent bg-accent/5 px-3 py-1 text-ink/85"
        />
      ),
      hr: () => <hr className="my-3 frame-divider" />,
      code: ({ node, className: cn, children, ...rest }) => {
        const isBlock = /\blanguage-/.test(cn ?? "") || String(children).includes("\n");
        if (isBlock) {
          return (
            <code
              {...rest}
              className={`block whitespace-pre overflow-x-auto border border-accent/25 bg-canvas/60 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink/90 ${cn ?? ""}`}
            >
              {children}
            </code>
          );
        }
        return (
          <code
            {...rest}
            className="border border-accent/30 bg-panel2/70 px-1 py-px font-mono text-[11.5px] text-accent"
          >
            {children}
          </code>
        );
      },
      pre: ({ node, children, ...rest }) => (
        <pre
          {...rest}
          className="my-2 overflow-x-auto border border-accent/25 bg-canvas/40"
        >
          {children}
        </pre>
      ),
      table: ({ node, ...p }) => (
        <div className="my-2 overflow-x-auto border border-accent/25">
          <table {...p} className="w-full border-collapse text-[12.5px]" />
        </div>
      ),
      thead: ({ node, ...p }) => <thead {...p} className="bg-panel2/60" />,
      th: ({ node, ...p }) => (
        <th
          {...p}
          className="border-b frame-divider px-2 py-1.5 text-left font-mono text-[10.5px] font-semibold uppercase tracking-wider text-accent"
        />
      ),
      td: ({ node, ...p }) => (
        <td {...p} className="border-b frame-divider px-2 py-1.5 text-ink/85" />
      ),
      input: ({ node, ...p }) =>
        // Task-list checkboxes ([ ] / [x]). react-markdown emits an <input>
        // when remark-gfm is enabled; render it disabled and themed.
        p.type === "checkbox" ? (
          <input
            {...p}
            disabled
            className="mr-1.5 h-3 w-3 align-middle accent-accent"
          />
        ) : (
          <input {...p} />
        ),
    }),
    [size],
  );

  return (
    <div className={`markdown ${className ?? ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
