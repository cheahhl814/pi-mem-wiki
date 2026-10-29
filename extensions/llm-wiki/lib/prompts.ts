import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VaultPaths } from "./utils.js";

/**
 * pi-mem-wiki fork (v2-d): vault-owner prompt overrides (upstream #171 —
 * "no customization hooks for the ingest and capture sub-agent calls").
 *
 * Location: `<vault>/.llm-wiki/prompts/<name>.md` — a human-editable file
 * (same ownership class as templates/, read-only to the extension). When the
 * file exists and is non-empty, its content is appended as a directive block
 * to the relevant sub-agent system prompt. Absent file = upstream behavior,
 * byte-for-byte.
 *
 * Security: the allowlist below is the traversal guard — arbitrary names are
 * rejected before any file access, so an override can never be aimed outside
 * the vault. Content is appended into a model-facing prompt on purpose (an
 * operator tuning their own vault), never rendered to the user as UI.
 */
const PROMPT_OVERRIDE_NAMES = new Set(["ingest-synthesis", "retro-guidance", "observe-guidance"]);

export function isKnownPromptOverride(name: string): boolean {
  return PROMPT_OVERRIDE_NAMES.has(name);
}

export function readPromptOverride(paths: VaultPaths, name: string): string | null {
  if (!isKnownPromptOverride(name)) return null;
  const overridePath = join(paths.dotWiki, "prompts", `${name}.md`);
  if (!existsSync(overridePath)) return null;
  try {
    const content = readFileSync(overridePath, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}