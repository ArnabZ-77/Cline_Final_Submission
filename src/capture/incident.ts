/**
 * Building `Incident` records from events.
 *
 * Trap 20: stack frames must live inside the app folder; anything outside it (the
 * benchmark harness, node internals) is dropped so Triage does not chase the wrong file.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { computeFingerprint } from "./fingerprint.ts";
import type { Incident, IncidentEvent, StackFrame, UsageTotals } from "../types.ts";

const MAX_STORED_EVENTS = 20;

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    costInr: 0,
    byStage: {},
  };
}

function isInside(appDir: string, target: string): boolean {
  const a = path.resolve(appDir).replace(/\\/g, "/").toLowerCase();
  const t = String(target).replace(/\\/g, "/").toLowerCase();
  return t === a || t.startsWith(a + "/");
}

/** Path of `target` relative to `appDir`, with forward slashes. */
function relativeToApp(appDir: string, target: string): string {
  return path.relative(path.resolve(appDir), path.resolve(target)).replace(/\\/g, "/");
}

/**
 * Frames inside the app folder, oldest first, with `filename` relative to the app folder
 * whatever root the reporter used.
 */
export function appFrames(ev: IncidentEvent, appDir: string): StackFrame[] {
  // Only the thrown exception's own stack (the last value, as the fingerprint uses):
  // concatenating the `err.cause` chain would make the last frame no longer the throw site.
  const values = ev?.exception?.values ?? [];
  const thrown = [...values].reverse().find((v) => (v?.stacktrace?.frames?.length ?? 0) > 0);
  const frames = thrown?.stacktrace?.frames ?? [];
  return frames
    .filter((f) => {
      if (f.abs_path) return isInside(appDir, f.abs_path);
      return f.in_app === true;
    })
    .map((f) => (f.abs_path ? { ...f, filename: relativeToApp(appDir, f.abs_path) } : f));
}

/** The innermost exception value (the one that was actually thrown). */
export function lastValue(ev: IncidentEvent) {
  const values = ev?.exception?.values ?? [];
  return values[values.length - 1] ?? { type: "Error", value: "" };
}

export function incidentTitle(ev: IncidentEvent): string {
  const { type, value } = lastValue(ev);
  const short = String(value).split("\n")[0].slice(0, 120);
  return short ? `${type}: ${short}` : `${type} in ${ev?.transaction ?? "request"}`;
}

export function createIncident(ev: IncidentEvent, repoName: string, appDir: string): Incident {
  const fingerprint = computeFingerprint(ev);
  const { type, value } = lastValue(ev);
  const now = new Date().toISOString();
  return {
    // Unique per incident, not per fingerprint: the id names the sandbox branch
    // (patchpilot/<id>), and a re-run after `demo:reset` must not collide with a branch
    // an earlier run already pushed.
    id: `inc_${Date.now().toString(36)}${fingerprint.slice(0, 6)}${randomBytes(2).toString("hex")}`,
    fingerprint,
    repo: repoName,
    title: incidentTitle(ev),
    exceptionType: type || "Error",
    exceptionValue: String(value ?? ""),
    events: [ev],
    occurrences: 1,
    firstSeen: now,
    lastSeen: now,
    stage: "received",
    stageHistory: [{ stage: "received", ts: now }],
    frames: appFrames(ev, appDir),
    attempts: [],
    guardrailBlocks: [],
    usage: emptyUsage(),
    timeline: [],
  };
}

export function recordOccurrence(inc: Incident, ev: IncidentEvent): void {
  inc.occurrences += 1;
  inc.lastSeen = new Date().toISOString();
  inc.events.push(ev);
  if (inc.events.length > MAX_STORED_EVENTS) {
    inc.events.splice(0, inc.events.length - MAX_STORED_EVENTS);
  }
}

/** Split a multi-line description into a stack-frame-free synthetic frame holder. */
function syntheticFrame(suspectFile?: string): StackFrame {
  return {
    filename: suspectFile || "unknown",
    function: "<reported>",
    lineno: 1,
    colno: 1,
    in_app: true,
  };
}

export interface ManualReport {
  title: string;
  description: string;
  suspectFile?: string;
  environment?: string;
  repo?: string;
}

/**
 * A plain-English bug report. It never throws, so it becomes a `ReportedBug` with one
 * synthetic frame. The title contributes to the fingerprint so two reports about the same
 * file stay separate incidents.
 */
export function manualEvent(report: ManualReport): IncidentEvent {
  const title = String(report.title || "").trim();
  const description = String(report.description || "").trim();
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return {
    event_id: `manual-${Date.now()}`,
    timestamp: new Date().toISOString(),
    platform: "other",
    level: "warning",
    environment: report.environment || process.env.NODE_ENV || "development",
    transaction: "manual report",
    message: description,
    tags: { repo: report.repo || "demo-app", source: "manual" },
    fingerprint: ["reported-bug", slug || "untitled"],
    exception: {
      values: [
        {
          type: "ReportedBug",
          value: title || description.slice(0, 120) || "manual bug report",
          mechanism: { type: "manual", handled: false },
          stacktrace: { frames: [syntheticFrame(report.suspectFile)] },
        },
      ],
    },
  };
}
