import { describe, expect, it } from "vitest";
import { getScalar, parseDoc, serializeDoc, setScalar } from "../editorFrontmatter";

describe("editorFrontmatter round-trip", () => {
  it("no frontmatter → body untouched; setScalar creates a block", () => {
    const doc = parseDoc("# Step\n\n## Goal\nDo it.\n");
    expect(doc.hasBlock).toBe(false);
    expect(serializeDoc(doc)).toBe("# Step\n\n## Goal\nDo it.\n");
    const withModel = setScalar(doc, "model", "opus");
    expect(serializeDoc(withModel)).toBe("---\nmodel: opus\n---\n# Step\n\n## Goal\nDo it.\n");
  });

  it("unknown keys, block lists, and comments survive edits byte-for-byte", () => {
    const src = `---
# authored by hand
model: sonnet
custom-flag: "yes"
depends-on:
  - setup
  - lint
step_id: build
---
# Body
`;
    const doc = parseDoc(src);
    expect(getScalar(doc, "model")).toBe("sonnet");
    expect(getScalar(doc, "custom-flag")).toBe("yes");
    // Round-trip without edits is identity.
    expect(serializeDoc(doc)).toBe(src);
    // Editing one scalar keeps everything else, including the block list.
    const edited = serializeDoc(setScalar(doc, "model", "haiku"));
    expect(edited).toContain("model: haiku");
    expect(edited).toContain("# authored by hand");
    expect(edited).toContain("  - setup\n  - lint");
    expect(edited).toContain('custom-flag: "yes"');
  });

  it("deleting a key removes only that key; deleting the last key drops the block", () => {
    const doc = parseDoc("---\nmodel: opus\nstep_id: x\n---\nbody\n");
    const one = setScalar(doc, "model", "");
    expect(serializeDoc(one)).toBe("---\nstep_id: x\n---\nbody\n");
    const none = setScalar(one, "step_id", "");
    expect(serializeDoc(none)).toBe("body\n");
  });

  it("body edits keep the frontmatter block", () => {
    const doc = parseDoc("---\nmodel: opus\n---\nold body\n");
    expect(serializeDoc({ ...doc, body: "new body\n" })).toBe("---\nmodel: opus\n---\nnew body\n");
  });
});
