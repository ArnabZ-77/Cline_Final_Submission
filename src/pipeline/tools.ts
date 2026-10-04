/**
 * The tools agents use inside the sandbox.
 *
 * Every path is resolved against the sandbox `cwd` and refused when it escapes, so no tool
 * can read or write outside the app folder.
 */
import fs from "node:fs";
import path from "node:path";

export const MAX_READ_LINES = 400;
/** Same 1 MB guard search_codebase uses, so one huge file cannot spike memory. */
export const MAX_READ_BYTES = 1024 * 1024;
export const MAX_SEARCH_QUERIES = 5;
export const MAX_MATCHES_PER_QUERY = 50;
export const SEARCH_SKIP_DIRS = new Set(["node_modules", ".git", ".patchpilot", "coverage"]);

export class ToolError extends Error {}

function realPathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Real path of `p` even when it does not exist yet: resolve the deepest existing ancestor
 * and re-append the rest. Otherwise a file created under a symlinked folder that points
 * outside the app would pass the check on its lexical path.
 */
function realPathOfDeepestExisting(p: string): string {
  let existing = p;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return p;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realPathOrSelf(existing), ...rest);
}

/** Resolves `input` inside `cwd`; throws when it would escape (Windows-safe). */
export function resolveInCwd(cwd: string, input: unknown): string {
  const root = realPathOrSelf(path.resolve(cwd));
  const raw = typeof input === "string" && input.length > 0 ? input : ".";
  const target = path.resolve(root, raw);
  const real = realPathOfDeepestExisting(target);
  const inside = real === root || real.startsWith(root + path.sep);
  if (!inside) throw new ToolError(`path escapes the working folder: ${String(input)}`);
  return real;
}

export function relativeTo(cwd: string, file: string): string {
  return path.relative(cwd, file).split(path.sep).join("/") || ".";
}

function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

// --- read_file ---------------------------------------------------------------------------

export interface ReadFileInput {
  path: string;
  start_line?: number;
  end_line?: number;
}

/** Numbered lines, at most 400, with a note about what was left out. */
export function readFile(cwd: string, input: ReadFileInput): string {
  const file = resolveInCwd(cwd, input.path);
  const stats = statSafe(file);
  if (!stats || !stats.isFile()) throw new ToolError(`no such file: ${input.path}`);
  if (stats.size > MAX_READ_BYTES) {
    throw new ToolError(`${input.path} is ${stats.size} bytes; files over ${MAX_READ_BYTES} bytes are not read`);
  }

  const all = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const total = all.length;
  const first = Math.max(1, Math.trunc(input.start_line ?? 1));
  const last = Math.min(total, Math.trunc(input.end_line ?? total));
  if (first > total) {
    throw new ToolError(`start_line ${first} is past the end of the file (${total} lines)`);
  }
  if (last < first) {
    throw new ToolError(`end_line ${last} is before start_line ${first}`);
  }

  const from = first - 1;
  const to = Math.min(last, from + MAX_READ_LINES) - 1;
  const body = all
    .slice(from, to + 1)
    .map((line, i) => `${from + i + 1}: ${line}`)
    .join("\n");

  // Count from the last line actually shown (the 400-line cap may stop before `last`).
  const shownLast = to + 1;
  const notes: string[] = [];
  if (first > 1) notes.push(`(${first - 1} more lines above)`);
  if (shownLast < total) notes.push(`(${total - shownLast} more lines below)`);
  return notes.length > 0 ? `${notes.join(" ")}\n${body}` : body;
}

// --- search_codebase ---------------------------------------------------------------------

export interface SearchInput {
  queries: string[];
}

function walkFiles(root: string, out: string[], depth = 0): void {
  if (depth > 12 || out.length > 5000) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, out, depth + 1);
    else if (entry.isFile()) out.push(full);
  }
}

/** At most 5 queries, 50 matches each, skipping node_modules/.git/.patchpilot. */
export function searchCodebase(cwd: string, input: SearchInput): string {
  const queries = (input.queries ?? []).filter((q) => typeof q === "string" && q.length > 0);
  if (queries.length === 0) throw new ToolError("provide at least one query");
  const capped = queries.length > MAX_SEARCH_QUERIES;
  const use = queries.slice(0, MAX_SEARCH_QUERIES);

  const files: string[] = [];
  walkFiles(path.resolve(cwd), files);

  const blocks: string[] = [];
  for (const query of use) {
    const needle = query.toLowerCase();
    const matches: string[] = [];
    for (const file of files) {
      if (matches.length >= MAX_MATCHES_PER_QUERY) break;
      if ((statSafe(file)?.size ?? 0) > 1024 * 1024) continue;
      let lines: string[];
      try {
        lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      } catch {
        continue;
      }
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        matches.push(`${relativeTo(cwd, file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (matches.length >= MAX_MATCHES_PER_QUERY) break;
      }
    }
    const truncated = matches.length >= MAX_MATCHES_PER_QUERY;
    blocks.push(
      matches.length === 0
        ? `## ${query}\n(no matches)`
        : `## ${query}\n${matches.join("\n")}${truncated ? "\n…capped at 50: narrow your query." : ""}`
    );
  }

  if (capped) {
    blocks.push(`Only the first ${MAX_SEARCH_QUERIES} queries were used: narrow your query.`);
  }
  return blocks.join("\n\n");
}


// --- editor ------------------------------------------------------------------------------

export interface EditorInput {
  path: string;
  old_text?: string;
  new_text: string;
  insert_line?: number;
}

export interface EditorResult {
  path: string;
  action: "created" | "replaced" | "inserted";
  lines: number;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

/**
 * Creates the file when missing, replaces `old_text` (which must match exactly once) or
 * inserts `new_text` before `insert_line`.
 */
export function editFile(cwd: string, input: EditorInput): EditorResult {
  const file = resolveInCwd(cwd, input.path);
  const newText = typeof input.new_text === "string" ? input.new_text : "";
  const rel = relativeTo(cwd, file);
  const exists = statSafe(file)?.isFile() ?? false;

  if (!exists) {
    if (input.old_text !== undefined) {
      throw new ToolError(`${rel} does not exist, so old_text cannot be replaced; omit old_text to create it`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, newText, "utf8");
    return { path: rel, action: "created", lines: newText.split(/\r?\n/).length };
  }

  const before = fs.readFileSync(file, "utf8");

  if (input.old_text !== undefined) {
    const oldText = input.old_text;
    const count = countOccurrences(before, oldText);
    if (count === 0) {
      throw new ToolError(
        `old_text was not found in ${rel} (0 matches). Read the file again and copy the exact text, ` +
          `including indentation. Note that lines end with \\n.`
      );
    }
    if (count > 1) {
      throw new ToolError(
        `old_text matches ${count} times in ${rel}; it must match exactly once. Add more surrounding ` +
          `context so the match is unique.`
      );
    }
    // Not String.replace: it would expand `$'`, `$&`, `$$` … inside new_text.
    const at = before.indexOf(oldText);
    const after = before.slice(0, at) + newText + before.slice(at + oldText.length);
    fs.writeFileSync(file, after, "utf8");
    return { path: rel, action: "replaced", lines: after.split(/\r?\n/).length };
  }

  if (typeof input.insert_line === "number") {
    const lines = before.split(/\r?\n/);
    const at = Math.trunc(input.insert_line);
    if (at < 1 || at > lines.length + 1) {
      throw new ToolError(`insert_line ${at} is outside the file (1-${lines.length + 1})`);
    }
    lines.splice(at - 1, 0, ...newText.split(/\r?\n/));
    const after = lines.join("\n");
    fs.writeFileSync(file, after, "utf8");
    return { path: rel, action: "inserted", lines: lines.length };
  }

  throw new ToolError(`give either old_text (to replace) or insert_line (to insert) for ${rel}`);
}

/** Whole-file write, used only where a tool needs it (guardrails treat it as a write). */
export function writeFile(cwd: string, input: { path: string; content: string }): EditorResult {
  const file = resolveInCwd(cwd, input.path);
  const existed = statSafe(file)?.isFile() ?? false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(input.content ?? ""), "utf8");
  return {
    path: relativeTo(cwd, file),
    action: existed ? "replaced" : "created",
    lines: String(input.content ?? "").split(/\r?\n/).length,
  };
}


// --- the tool set handed to an Agent ------------------------------------------------------

export interface ToolSet {
  read_file: (input: ReadFileInput) => string;
  search_codebase: (input: SearchInput) => string;
  editor: (input: EditorInput) => EditorResult;
  write_file: (input: { path: string; content: string }) => EditorResult;
}

/** Tools every stage gets. `flag_for_human_intervention` is added by the Fixer (Phase 7). */
export function makeToolFunctions(cwd: string): ToolSet {
  return {
    read_file: (input) => readFile(cwd, input),
    search_codebase: (input) => searchCodebase(cwd, input),
    editor: (input) => editFile(cwd, input),
    write_file: (input) => writeFile(cwd, input),
  };
}

type AnyToolFn = (...args: never[]) => unknown;

const DEFINITIONS = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 file from the app folder. Returns numbered lines, at most 400 at a time. " +
      "Use start_line and end_line to page through long files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the app folder" },
        start_line: { type: "number", description: "1-based first line to show" },
        end_line: { type: "number", description: "1-based last line to show" },
      },
      required: ["path"],
    },
    fn: "read_file" as const,
  },
  {
    name: "search_codebase",
    description:
      "Search the app folder for one or more literal strings (up to 5 queries). " +
      "Returns file:line for every match, capped at 50 matches per query.",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Literal strings to search for (case-insensitive)",
        },
      },
      required: ["queries"],
    },
    fn: "search_codebase" as const,
  },
  {
    name: "editor",
    description:
      "Create or edit a file in the app folder. To change existing text pass old_text, which must " +
      "appear exactly once, plus new_text. To insert at a position pass insert_line (1-based) " +
      "plus new_text. Omit old_text and insert_line to create the file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the app folder" },
        old_text: { type: "string", description: "Exact text to replace; must match exactly once" },
        new_text: { type: "string", description: "Replacement or inserted text" },
        insert_line: { type: "number", description: "1-based line to insert before" },
      },
      required: ["path", "new_text"],
    },
    fn: "editor" as const,
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a whole file in the app folder. Prefer editor for changes to existing files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the app folder" },
        content: { type: "string", description: "Full new contents of the file" },
      },
      required: ["path", "content"],
    },
    fn: "write_file" as const,
  },
];

/**
 * Builds the `AgentTool` list for a stage. Every tool is already bound to `cwd`, so it can
 * never touch anything outside the sandbox.
 */
export function makeTools(cwd: string): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: never, context?: unknown) => Promise<unknown>;
}> {
  const fns = makeToolFunctions(cwd);
  return DEFINITIONS.map((def) => {
    const fn = fns[def.fn] as unknown as AnyToolFn;
    return {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      async execute(input: never) {
        try {
          return await fn(input as never);
        } catch (err) {
          // Tool errors are information for the model, not pipeline failures.
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    };
  });
}

