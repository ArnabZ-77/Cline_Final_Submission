/**
 * Localisation: turn stack frames into ranked suspects for Triage, and give agents a
 * bounded view of the repo.
 *
 * Suspects are in-app frames only (test files excluded), scored `1 / (1 + depth)` where
 * depth 0 is the frame that threw (the last one). Each gets the line range of its enclosing
 * function, found by brace matching.
 */
import fs from "node:fs";
import path from "node:path";
import { isTestPath } from "../pipeline/guardrails.ts";
import type { RepoConfig, StackFrame, Suspect } from "../types.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", ".patchpilot", "coverage", "dist", "build"]);

/**
 * Masks strings, template literals and comments with spaces (newlines kept), so brace
 * matching only sees code braces.
 */
export function maskNonCode(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\") j += 1;
        else if (src[j] === "\n" && ch !== "`") break;
        j += 1;
      }
      blank(i, j + 1);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

const FUNCTION_HEAD =
  /\bfunction\b|=>\s*\{?\s*$|^\s*(?:export\s+)?(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/;

/**
 * 1-based [start, end] of the function enclosing `line`, by brace matching. Falls back to
 * the outermost enclosing block, then to a window around the line.
 */
export function enclosingFunctionRange(source: string, line: number): { start: number; end: number } {
  const masked = maskNonCode(source);
  const lines = source.split(/\r?\n/);
  const blocks: Array<{ open: number; close: number }> = [];
  const stack: number[] = [];
  let ln = 1;
  for (const ch of masked) {
    if (ch === "\n") ln += 1;
    else if (ch === "{") stack.push(ln);
    else if (ch === "}") {
      const open = stack.pop();
      if (open !== undefined) blocks.push({ open, close: ln });
    }
  }
  const containing = blocks
    .filter((b) => b.open <= line && b.close >= line)
    .sort((a, b) => b.open - a.open); // innermost first
  const fn = containing.find((b) => FUNCTION_HEAD.test(lines[b.open - 1] ?? ""));
  const pick = fn ?? containing.at(-1);
  if (pick) {
    // Include a preceding `export function name(` line when the brace sits on its own line.
    let start = pick.open;
    if (!FUNCTION_HEAD.test(lines[start - 1] ?? "") && start > 1 && FUNCTION_HEAD.test(lines[start - 2] ?? "")) start -= 1;
    return { start, end: pick.close };
  }
  return { start: Math.max(1, line - 10), end: Math.min(lines.length, line + 10) };
}

function toRel(p: string): string {
  return String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Ranked suspects from in-app frames; the frame that threw scores 1. */
export function rankSuspects(
  frames: StackFrame[],
  cwd: string,
  repo: Pick<RepoConfig, "testPaths">
): Suspect[] {
  const usable = frames.filter((f) => f.in_app !== false && f.filename && !isTestPath(toRel(f.filename), repo));
  const byKey = new Map<string, Suspect>();
  usable
    .slice()
    .reverse() // depth 0 = throw site
    .forEach((f, depth) => {
      const file = toRel(f.filename);
      const abs = path.join(cwd, file);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
      const score = Math.round((1 / (1 + depth)) * 1000) / 1000;
      const key = `${file}#${f.function ?? ""}`;
      if (byKey.has(key)) return; // keep the deepest (highest-scoring) occurrence
      const source = fs.readFileSync(abs, "utf8");
      const line = f.lineno && f.lineno > 0 && f.function !== "<reported>" ? f.lineno : 0;
      const range = line ? enclosingFunctionRange(source, line) : { start: 1, end: source.split(/\r?\n/).length };
      byKey.set(key, {
        file,
        symbol: f.function && !f.function.startsWith("<") ? f.function : undefined,
        lineStart: range.start,
        lineEnd: range.end,
        score,
        reason: line ? `stack frame at line ${line}` : "named in the bug report",
      });
    });
  return [...byKey.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Numbered source lines of a suspect, for the prompt. */
export function suspectSnippet(cwd: string, s: Suspect, maxLines = 60): string {
  const abs = path.join(cwd, s.file);
  if (!fs.existsSync(abs)) return "";
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  const start = Math.max(1, s.lineStart ?? 1);
  const end = Math.min(lines.length, s.lineEnd ?? lines.length, start + maxLines - 1);
  return lines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}: ${l}`)
    .join("\n");
}

/** A bounded, sorted listing of the app folder. */
export function repoTree(cwd: string, maxEntries = 200, maxDepth = 5): string {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || out.length >= maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxEntries) break;
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const rel = toRel(path.relative(cwd, path.join(dir, e.name)));
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        walk(path.join(dir, e.name), depth + 1);
      } else {
        out.push(rel);
      }
    }
  };
  walk(cwd, 0);
  if (out.length >= maxEntries) out.push(`… (listing capped at ${maxEntries} entries)`);
  return out.join("\n");
}

/** Every file under the configured test folders (relative to cwd). */
export function listTestFiles(cwd: string, repo: Pick<RepoConfig, "testPaths">): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else files.push(toRel(path.relative(cwd, abs)));
    }
  };
  for (const t of repo.testPaths) walk(path.join(cwd, t));
  return files.sort();
}
