/**
 * Configuration, paths and environment loading.
 *
 * Trap 23: `.env` values are strings ("0" is truthy), shell env wins over `.env`, and the
 * loader only fills keys that are not already set.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoConfig } from "./types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root of PatchPilot itself (the parent of `src/`). */
export const PROJECT_ROOT = path.resolve(HERE, "..");

export const DATA_DIR = path.join(PROJECT_ROOT, ".patchpilot");
export const INCIDENTS_DIR = path.join(DATA_DIR, "incidents");
export const SANDBOXES_DIR = path.join(DATA_DIR, "sandboxes");
export const CONFIG_PATH = path.join(PROJECT_ROOT, "patchpilot.config.json");

/** Normalise to forward slashes so paths compare and log identically on Windows. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Minimal `.env` parser: `KEY=value`, `#` comments, quotes stripped. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

/** Fills only keys that are not already present in `process.env`. Returns the keys set. */
export function loadEnvFile(file: string = path.join(PROJECT_ROOT, ".env")): string[] {
  if (!fs.existsSync(file)) return [];
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const parsed = parseEnvText(text);
  const set: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      set.push(key);
    }
  }
  return set;
}

loadEnvFile();

/** Trap 23: compare against "1", never truthiness. */
export function isMockMode(): boolean {
  return process.env.PATCHPILOT_MOCK === "1";
}

/** Kept as a named export because the spec names it; prefer `isMockMode()` in code paths. */
export const MOCK_MODE = isMockMode();

// --- config ----------------------------------------------------------------------------

export interface PatchPilotConfig {
  defaultRepo: string;
  maxFixAttempts: number;
  minTriageConfidence: number;
  repos: Record<string, RepoConfig>;
}

const DEFAULT_REPO_CONFIG: Omit<RepoConfig, "root" | "subdir"> = {
  testCommand: ["node", "--test"],
  testPaths: ["tests"],
  protectedPaths: ["server.js", "package.json", "package-lock.json", ".env", ".env.*"],
  maxDiffLines: 150,
  maxDiffFiles: 3,
  baseRef: "HEAD",
};

function normaliseRepoConfig(name: string, raw: Partial<RepoConfig>, baseDir: string): RepoConfig {
  if (raw.testCommand !== undefined && (!Array.isArray(raw.testCommand) || raw.testCommand.length === 0)) {
    throw new Error(`patchpilot.config.json: repos.${name}.testCommand must be a non-empty array of strings`);
  }
  const root = path.resolve(baseDir, raw.root ?? ".");
  // "" stays "" so `appDirOf` equals `root` for a repo whose app folder is its root.
  const subdir = raw.subdir === undefined ? "" : raw.subdir;
  return {
    root: toPosix(root),
    subdir: toPosix(subdir),
    testCommand: raw.testCommand ?? DEFAULT_REPO_CONFIG.testCommand,
    testPaths: raw.testPaths ?? DEFAULT_REPO_CONFIG.testPaths,
    protectedPaths: raw.protectedPaths ?? DEFAULT_REPO_CONFIG.protectedPaths,
    maxDiffLines: raw.maxDiffLines ?? DEFAULT_REPO_CONFIG.maxDiffLines,
    maxDiffFiles: raw.maxDiffFiles ?? DEFAULT_REPO_CONFIG.maxDiffFiles,
    baseRef: raw.baseRef ?? DEFAULT_REPO_CONFIG.baseRef,
  };
}

/** Absolute path of the app folder: where the agents work and where tests run. */
export function appDirOf(repo: RepoConfig): string {
  return path.resolve(repo.root, repo.subdir);
}

export function loadConfig(
  configPath: string = CONFIG_PATH,
  baseDir: string = PROJECT_ROOT
): PatchPilotConfig {
  const text = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(text) as Partial<PatchPilotConfig> & {
    repos?: Record<string, Partial<RepoConfig>>;
  };
  const repos: Record<string, RepoConfig> = {};
  for (const [name, raw] of Object.entries(parsed.repos ?? {})) {
    repos[name] = normaliseRepoConfig(name, raw ?? {}, baseDir);
  }
  // Fail loudly: a typo here would otherwise surface as every request answering 400.
  if (Object.keys(repos).length === 0) {
    throw new Error(`${configPath}: "repos" is empty; add at least one target repo`);
  }
  if (parsed.defaultRepo && !repos[parsed.defaultRepo]) {
    throw new Error(
      `${configPath}: defaultRepo "${parsed.defaultRepo}" is not in repos (${Object.keys(repos).join(", ")})`
    );
  }
  const defaultRepo = parsed.defaultRepo ?? Object.keys(repos)[0];
  return {
    defaultRepo,
    maxFixAttempts: parsed.maxFixAttempts ?? 3,
    minTriageConfidence: parsed.minTriageConfidence ?? 0.35,
    repos,
  };
}


// --- models ----------------------------------------------------------------------------

export interface ModelSettings {
  providerId: string;
  modelId: string;
  fallbackModelId?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Providers whose tools execute inside their own process bypass `beforeTool`, so the
 * guardrails would not run. Trap 17.
 */
export const PROVIDER_EXECUTED_TOOL_PROVIDERS = ["claude-code", "openai-codex-cli", "opencode"];

const ENV_KEYS_BY_PROVIDER: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  ollama: [],
  "openai-compatible": ["PATCHPILOT_API_KEY", "OPENAI_API_KEY"],
};

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_FALLBACK_MODEL = "claude-sonnet-5-5";

export function assertNoProviderExecutedTools(providerId: string): void {
  if (
    PROVIDER_EXECUTED_TOOL_PROVIDERS.includes(providerId) &&
    process.env.PATCHPILOT_ALLOW_PROVIDER_TOOLS !== "1"
  ) {
    throw new Error(
      `provider "${providerId}" runs tools inside its own process, which bypasses PatchPilot's guardrails. ` +
        `Use a standard API provider, or set PATCHPILOT_ALLOW_PROVIDER_TOOLS=1 to override.`
    );
  }
}

/** Picks the API key for the provider; `PATCHPILOT_API_KEY` always wins when set. */
export function apiKeyFor(providerId: string): string | undefined {
  if (process.env.PATCHPILOT_API_KEY) return process.env.PATCHPILOT_API_KEY;
  for (const key of ENV_KEYS_BY_PROVIDER[providerId] ?? []) {
    if (process.env[key]) return process.env[key];
  }
  return undefined;
}

export function resolveModelSettings(env: NodeJS.ProcessEnv = process.env): ModelSettings {
  const providerId = env.PATCHPILOT_PROVIDER || DEFAULT_PROVIDER;
  assertNoProviderExecutedTools(providerId);
  return {
    providerId,
    modelId: env.PATCHPILOT_MODEL || DEFAULT_MODEL,
    fallbackModelId: env.PATCHPILOT_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL,
    apiKey: apiKeyFor(providerId),
    baseUrl: env.PATCHPILOT_BASE_URL || undefined,
  };
}

export function inrPerUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PATCHPILOT_INR_PER_USD ?? "96");
  return Number.isFinite(raw) && raw > 0 ? raw : 96;
}

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, INCIDENTS_DIR, SANDBOXES_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const SERVER_PORT = Number(process.env.PATCHPILOT_PORT || "4747");

