/**
 * Incident storage: memory plus one JSON file per incident, written atomically.
 *
 * Every step of the pipeline is announced through `log()`, which appends to the incident
 * timeline and emits an `event` event that the SSE endpoint forwards to the dashboard.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { INCIDENTS_DIR, ensureDirs } from "./config.ts";
import type { Incident, Stage, TimelineEntry } from "./types.ts";

const MAX_TIMELINE = 2000;

export const FINISHED_STAGES: Stage[] = ["done", "needs_human", "failed"];

export interface ChangeEvent {
  incidentId: string;
  stage: Stage;
  entry: TimelineEntry;
}

export class IncidentStore extends EventEmitter {
  private incidents = new Map<string, Incident>();
  private readonly dir: string;

  constructor(dir: string = INCIDENTS_DIR) {
    super();
    this.dir = dir;
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  /** Load incidents from disk; anything unfinished from a previous run is marked failed. */
  load(): void {
    ensureDirs();
    fs.mkdirSync(this.dir, { recursive: true });
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.dir, name);
      let inc: Incident;
      try {
        inc = JSON.parse(fs.readFileSync(file, "utf8")) as Incident;
      } catch {
        continue;
      }
      if (!inc?.id || typeof inc.id !== "string") continue;
      // A truncated or hand-edited file must not crash the server at boot.
      inc.timeline = Array.isArray(inc.timeline) ? inc.timeline : [];
      inc.stageHistory = Array.isArray(inc.stageHistory) ? inc.stageHistory : [];
      inc.attempts = Array.isArray(inc.attempts) ? inc.attempts : [];
      inc.guardrailBlocks = Array.isArray(inc.guardrailBlocks) ? inc.guardrailBlocks : [];
      inc.events = Array.isArray(inc.events) ? inc.events : [];
      inc.frames = Array.isArray(inc.frames) ? inc.frames : [];
      inc.lastSeen = typeof inc.lastSeen === "string" ? inc.lastSeen : new Date(0).toISOString();
      inc.usage ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, costInr: 0 };
      if (!FINISHED_STAGES.includes(inc.stage)) {
        inc.stage = "failed";
        inc.error = "PatchPilot restarted before this incident finished";
        inc.finishedAt = new Date().toISOString();
        this.pushTimeline(inc, "error", inc.error);
        inc.stageHistory.push({ stage: "failed", ts: inc.finishedAt, note: "restart" });
        this.save(inc);
      }
      this.incidents.set(inc.id, inc);
    }
  }

  list(): Incident[] {
    return [...this.incidents.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  get(id: string): Incident | undefined {
    return this.incidents.get(id);
  }

  findByFingerprint(fingerprint: string, repo: string): Incident | undefined {
    for (const inc of this.incidents.values()) {
      if (inc.fingerprint === fingerprint && inc.repo === repo) return inc;
    }
    return undefined;
  }

  add(inc: Incident): Incident {
    this.incidents.set(inc.id, inc);
    this.save(inc);
    return inc;
  }

  save(inc: Incident): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.fileFor(inc.id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(inc, null, 2), "utf8");
    fs.renameSync(tmp, file);
  }

  private pushTimeline(inc: Incident, type: string, text: string, data?: unknown): TimelineEntry {
    const entry: TimelineEntry = { ts: new Date().toISOString(), type, text, data };
    inc.timeline.push(entry);
    if (inc.timeline.length > MAX_TIMELINE) {
      inc.timeline.splice(0, inc.timeline.length - MAX_TIMELINE);
    }
    return entry;
  }

  /** Append to the timeline, persist, and announce. */
  log(inc: Incident, type: string, text: string, data?: unknown): void {
    const entry = this.pushTimeline(inc, type, text, data);
    this.save(inc);
    const payload: ChangeEvent = { incidentId: inc.id, stage: inc.stage, entry };
    this.emit("event", payload);
  }

  /** Append a stage change to the timeline and the stage history. */
  setStage(inc: Incident, stage: Stage, note?: string): void {
    inc.stage = stage;
    inc.stageHistory.push({ stage, ts: new Date().toISOString(), note });
    this.log(inc, "stage", `stage: ${stage}`, { stage, note });
  }
}
