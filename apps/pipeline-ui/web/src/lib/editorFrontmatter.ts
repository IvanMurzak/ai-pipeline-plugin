/** Round-trip-safe YAML-frontmatter editing for the structured editor.
 *
 *  The plugin's frontmatter contract is deliberately simple (scalar strings +
 *  inline/block lists — see pipeline-cli's lib/frontmatter.ts), but the editor
 *  must NEVER corrupt keys it doesn't understand. So each field keeps its RAW
 *  original lines: editing a known key replaces just that field's lines;
 *  everything else is reproduced byte-for-byte, in order. */

export interface FmField {
  key: string;
  /** The field's original (or regenerated) lines, without trailing newline. */
  raw: string[];
}

export interface ParsedDoc {
  hasBlock: boolean;
  fields: FmField[];
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseDoc(text: string): ParsedDoc {
  const m = FM_RE.exec(text);
  if (!m) return { hasBlock: false, fields: [], body: text };
  const body = text.slice(m[0].length);
  const lines = m[1].split(/\r?\n/);
  const fields: FmField[] = [];
  let current: FmField | null = null;
  for (const line of lines) {
    // A new top-level key starts a field; indented / list / comment lines
    // belong to the previous field's raw block.
    const keyMatch = /^([A-Za-z0-9_-]+):/.exec(line);
    if (keyMatch && !/^\s/.test(line)) {
      current = { key: keyMatch[1], raw: [line] };
      fields.push(current);
    } else if (current) {
      current.raw.push(line);
    } else {
      // Leading comment/blank before any key — keep as an anonymous field.
      current = { key: "", raw: [line] };
      fields.push(current);
    }
  }
  return { hasBlock: true, fields, body };
}

export function serializeDoc(doc: ParsedDoc): string {
  if (!doc.hasBlock && doc.fields.length === 0) return doc.body;
  if (doc.fields.length === 0) return doc.body;
  const block = doc.fields.flatMap((f) => f.raw).join("\n");
  return `---\n${block}\n---\n${doc.body}`;
}

/** The scalar value of a key ('' when absent or non-scalar). */
export function getScalar(doc: ParsedDoc, key: string): string {
  const f = doc.fields.find((x) => x.key === key);
  if (!f) return "";
  const m = /^[A-Za-z0-9_-]+:\s*(.*)$/.exec(f.raw[0]);
  const v = (m?.[1] ?? "").trim();
  return v.replace(/^["']|["']$/g, "");
}

/** Set (or delete with '') a scalar key, preserving every other field. */
export function setScalar(doc: ParsedDoc, key: string, value: string): ParsedDoc {
  const fields = doc.fields;
  const idx = fields.findIndex((f) => f.key === key);
  const trimmed = value.trim();
  if (trimmed === "") {
    return { ...doc, hasBlock: true, fields: fields.filter((f) => f.key !== key) };
  }
  const line = `${key}: ${trimmed}`;
  if (idx >= 0) {
    const next = fields.slice();
    next[idx] = { key, raw: [line] };
    return { ...doc, hasBlock: true, fields: next };
  }
  return { ...doc, hasBlock: true, fields: [...fields, { key, raw: [line] }] };
}
