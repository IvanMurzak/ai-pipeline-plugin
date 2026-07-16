"""Validate the plugin's structural contracts.

Run in CI to catch typos, missing files, or malformed JSON/frontmatter before
they ship to users (Claude Code caches by name@version, so a broken manifest
strands every consumer until the version is bumped again).

Checks performed:
  1. .claude-plugin/plugin.json parses as JSON and has required top-level keys.
  2. hooks/hooks.json parses as JSON; every script path it references exists
     under the repo (after stripping ${CLAUDE_PLUGIN_ROOT}).
  3. Every agents/*.md begins with a YAML frontmatter block and declares a
     name + description.
  4. Every direct child of skills/ is a directory containing a SKILL.md with
     a YAML frontmatter block declaring name + description.
  5. The plugin.json version field looks like semver (N.N.N).

Exit code 0 on success, 1 on any failure.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

PLUGIN_ROOT_REF_RE = re.compile(r"\$\{CLAUDE_PLUGIN_ROOT\}/([^\s\"']+)")

REPO_ROOT = Path(__file__).resolve().parents[2]
PLUGIN_JSON = REPO_ROOT / ".claude-plugin" / "plugin.json"
HOOKS_JSON = REPO_ROOT / "hooks" / "hooks.json"
AGENTS_DIR = REPO_ROOT / "agents"
SKILLS_DIR = REPO_ROOT / "skills"

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+].+)?$")
FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n", re.DOTALL)


def load_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        errors.append(f"{path.relative_to(REPO_ROOT)}: file not found")
    except json.JSONDecodeError as exc:
        errors.append(f"{path.relative_to(REPO_ROOT)}: invalid JSON — {exc}")
    return None


def parse_frontmatter(text: str) -> dict[str, str] | None:
    match = FRONTMATTER_RE.match(text)
    if not match:
        return None
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" not in line or line.startswith(" "):
            continue
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip()
    return fields


errors: list[str] = []

# 1. plugin.json
plugin = load_json(PLUGIN_JSON)
if plugin is not None:
    for key in ("name", "version", "description", "author"):
        if key not in plugin:
            errors.append(f"plugin.json: missing required key '{key}'")
    version = plugin.get("version", "")
    if version and not SEMVER_RE.match(version):
        errors.append(f"plugin.json: version '{version}' is not semver (N.N.N)")

# 2. hooks/hooks.json — referenced script paths must exist
if HOOKS_JSON.exists():
    hooks = load_json(HOOKS_JSON)
    if hooks is not None:
        for event, entries in hooks.get("hooks", {}).items():
            for entry in entries:
                for hook in entry.get("hooks", []):
                    cmd = hook.get("command", "")
                    for match in PLUGIN_ROOT_REF_RE.finditer(cmd):
                        rel = match.group(1)
                        target = REPO_ROOT / rel
                        if not target.exists():
                            errors.append(
                                f"hooks.json ({event}): referenced file does not exist — {rel}"
                            )

# 3. agents/*.md — every agent has frontmatter with name + description
if AGENTS_DIR.is_dir():
    agent_files = sorted(AGENTS_DIR.glob("*.md"))
    if not agent_files:
        errors.append("agents/: no agent files found")
    for agent in agent_files:
        text = agent.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        if fm is None:
            errors.append(f"{agent.relative_to(REPO_ROOT)}: missing YAML frontmatter")
            continue
        for key in ("name", "description"):
            if key not in fm:
                errors.append(
                    f"{agent.relative_to(REPO_ROOT)}: frontmatter missing '{key}'"
                )

# 4. skills/<name>/SKILL.md — every skill folder has a SKILL.md with frontmatter
if SKILLS_DIR.is_dir():
    skill_dirs = sorted(p for p in SKILLS_DIR.iterdir() if p.is_dir())
    if not skill_dirs:
        errors.append("skills/: no skill folders found")
    for skill_dir in skill_dirs:
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.exists():
            errors.append(f"{skill_dir.relative_to(REPO_ROOT)}: missing SKILL.md")
            continue
        text = skill_md.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        if fm is None:
            errors.append(
                f"{skill_md.relative_to(REPO_ROOT)}: missing YAML frontmatter"
            )
            continue
        for key in ("name", "description"):
            if key not in fm:
                errors.append(
                    f"{skill_md.relative_to(REPO_ROOT)}: frontmatter missing '{key}'"
                )

if errors:
    print("Manifest validation FAILED:", file=sys.stderr)
    for err in errors:
        print(f"  - {err}", file=sys.stderr)
    sys.exit(1)

print(f"Manifest validation OK ({len(list(AGENTS_DIR.glob('*.md')))} agents, "
      f"{len([p for p in SKILLS_DIR.iterdir() if p.is_dir()])} skills).")
