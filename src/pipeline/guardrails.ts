/**
 * Guardrails: the `beforeTool` hook every agent runs with.
 *
 * They are enforced in code, not in prompts. A blocked call returns `{ skip: true, reason }`,
 * so the agent receives the reason instead of the tool's result, and every block is reported
 * through `onBlock` so it shows up on the incident and the dashboard.
 *
 * Paths are normalised against the sandbox `cwd` before any rule is checked, so
 * `./tests/../server.js` or `src\..\server.js` is judged as `server.js`.
 */
import path from "node:path";
import type { GuardrailBlock, RepoConfig, Stage } from "../types.ts";

/** Tools that write files. */
export const WRITE_TOOLS = new Set(["editor", "apply_patch", "write_file", "write_files"]);

/** Tools that run a shell command (none are handed to PatchPilot's agents, but be safe). */
export const SHELL_TOOLS = new Set(["run_command", "execute_command", "shell", "bash", "exec", "run_shell"]);

const DANGEROUS_COMMANDS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, why: "recursive force delete (rm -rf)" },
  { re: /\bgit\s+push\b/i, why: "git push (PatchPilot pushes, agents never do)" },
  { re: /\bgit\s+reset\s+--hard\b/i, why: "git reset --hard" },
  { re: /\bgit\s+checkout\s+--\s/i, why: "git checkout -- (discards changes)" },
  { re: /\bcurl\b/i, why: "network access (curl)" },
  { re: /\bwget\b/i, why: "network access (wget)" },
  { re: /\bnpm\s+publish\b/i, why: "npm publish" },
];

// --- path rules (shared with the hard checks) ----------------------------------------------

/** Forward slashes, no leading `./`, no trailing `/`. */
export function toRel(p: string): string {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
}

/**
 * Resolves an agent-supplied path against `cwd` and returns it relative to `cwd`, or
 * `null` when it escapes the working folder.
 */
export function normaliseAgentPath(cwd: string, p: string): string | null {
  const abs = path.resolve(cwd, String(p ?? ""));
  const rel = path.relative(path.resolve(cwd), abs);
  if (rel === "" ) return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return toRel(rel);
}

/** Glob → RegExp: `*` stays within a path segment, `**` crosses segments. */
export function globToRegExp(glob: string): RegExp {
  const g = toRel(glob);
  let re = "";
  for (let i = 0; i < g.length; i += 1) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        // `**/` matches zero or more whole segments; a trailing `**` matches the rest.
        if (g[i + 2] === "/") {
          re += "(?:[^/]+/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "i");
}

/**
 * True when `rel` matches `glob`. A glob without a `/` also matches the basename at any
 * depth (like .gitignore), so `.env` protects `config/.env` too. A glob naming a folder
 * (`sdk`, `sdk/**`) covers everything inside it.
 */
export function matchesGlob(rel: string, glob: string): boolean {
  const r = toRel(rel);
  const g = toRel(glob);
  if (!g) return false;
  if (globToRegExp(g).test(r)) return true;
  if (!g.includes("/") && globToRegExp(g).test(r.split("/").pop() ?? "")) return true;
  // A plain folder name covers its contents.
  if (!/[*?]/.test(g) && (r.toLowerCase() === g.toLowerCase() || r.toLowerCase().startsWith(`${g.toLowerCase()}/`))) {
    return true;
  }
  return false;
}

export function isProtectedPath(rel: string, repo: Pick<RepoConfig, "protectedPaths">): boolean {
  return (repo.protectedPaths ?? []).some((g) => matchesGlob(rel, g));
}

/** Test files by convention (`tests/`, `__tests__/`, `*.test.*`, `*.spec.*`) or by config. */
export function isTestPath(rel: string, repo: Pick<RepoConfig, "testPaths">): boolean {
  const r = toRel(rel);
  if (/(^|\/)(tests?|__tests__)\//i.test(r)) return true;
  if (/\.(test|spec)\.[^/]+$/i.test(r)) return true;
  return (repo.testPaths ?? []).some((t) => matchesGlob(r, t) || r.toLowerCase().startsWith(`${toRel(t).toLowerCase()}/`));
}

/** True when `rel` is inside one of `roots` (folders or globs). */
export function isUnder(rel: string, roots: string[]): boolean {
  return roots.some((root) => matchesGlob(rel, root) || toRel(rel).toLowerCase().startsWith(`${toRel(root).toLowerCase()}/`));
}

// --- extracting what a tool call would touch ----------------------------------------------

/** Every path a write tool call would write. */
export function writeTargets(toolName: string, input: unknown): string[] {
  const i = (input ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.length > 0) out.push(v);
  };
  push(i.path);
  push(i.file_path);
  push(i.filePath);
  if (Array.isArray(i.files)) {
    for (const f of i.files) push(typeof f === "string" ? f : (f as Record<string, unknown>)?.path);
  }
  if (toolName === "apply_patch") {
    const patch = String(i.patch ?? i.input ?? i.diff ?? "");
    for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) push(m[1].trim());
    for (const m of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) push(m[1].trim());
    for (const m of patch.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(.+)$/gm)) if (m[1].trim() !== "/dev/null") push(m[1].trim());
  }
  return [...new Set(out)];
}

export function commandOf(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const c = i.command ?? i.cmd ?? i.script ?? "";
  return Array.isArray(c) ? c.join(" ") : String(c);
}

// --- the hook ------------------------------------------------------------------------------

export interface GuardrailOptions {
  stage: Stage;
  repo: Pick<RepoConfig, "testPaths" | "protectedPaths">;
  /** Sandbox app folder; agent paths are resolved against it. */
  cwd: string;
  /** When set, writes are allowed only inside these folders/globs (the Reproducer: testPaths). */
  allowWritePaths?: string[];
  /** Files nobody may write (the locked reproduction test). Relative to `cwd`. */
  lockedFiles?: string[];
  onBlock?: (block: GuardrailBlock) => void;
  /** Every tool call, allowed or not (mock and real runs both pass through here). */
  onCall?: (tool: string, input: unknown) => void;
}

export interface BeforeToolArgs {
  tool?: { name?: string };
  toolCall?: { toolName?: string; input?: unknown };
  input?: unknown;
}

export type BeforeToolResult = { skip: true; reason: string } | undefined;

/** The reason a single write to `rawPath` must be refused, or undefined to allow it. */
export function writeViolation(opts: GuardrailOptions, rawPath: string): string | undefined {
  if (opts.stage === "triage") return "Triage is read-only: no file may be written in this stage.";
  const rel = normaliseAgentPath(opts.cwd, rawPath);
  if (rel === null) return `${rawPath} is outside the working folder.`;
  if (isProtectedPath(rel, opts.repo)) return `${rel} is a protected path and may not be changed.`;
  if ((opts.lockedFiles ?? []).some((f) => toRel(f).toLowerCase() === rel.toLowerCase())) {
    return `${rel} is the locked reproduction test; it may not be changed.`;
  }
  if (opts.stage === "fix" && isTestPath(rel, opts.repo)) {
    return `${rel} is a test file. The Fixer must change the code, never a test.`;
  }
  if (opts.allowWritePaths && !isUnder(rel, opts.allowWritePaths)) {
    return `${rel} is outside the folders this stage may write (${opts.allowWritePaths.join(", ")}).`;
  }
  return undefined;
}

export function commandViolation(command: string): string | undefined {
  for (const { re, why } of DANGEROUS_COMMANDS) if (re.test(command)) return `command refused: ${why}.`;
  return undefined;
}

export function makeBeforeTool(opts: GuardrailOptions) {
  return function beforeTool(args: BeforeToolArgs): BeforeToolResult {
    const toolName = args.tool?.name ?? args.toolCall?.toolName ?? "";
    const input = args.input ?? args.toolCall?.input;
    opts.onCall?.(toolName, input);
    let reason: string | undefined;

    if (WRITE_TOOLS.has(toolName)) {
      const targets = writeTargets(toolName, input);
      if (targets.length === 0) {
        reason = opts.stage === "triage" ? writeViolation(opts, ".") : "write refused: no target path given.";
      } else {
        for (const t of targets) {
          reason = writeViolation(opts, t);
          if (reason) break;
        }
      }
    } else if (SHELL_TOOLS.has(toolName)) {
      reason = commandViolation(commandOf(input));
    }

    if (!reason) return undefined;
    opts.onBlock?.({ ts: new Date().toISOString(), stage: opts.stage, tool: toolName, input, reason });
    return { skip: true, reason };
  };
}
