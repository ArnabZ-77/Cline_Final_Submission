/**
 * The PatchPilot HTTP server.
 *
 * Express 5. Trap 9: `listen` receives its error through the callback, so we must check it.
 */
import express from "express";
import path from "node:path";
import { z } from "zod";
import { PROJECT_ROOT, SERVER_PORT, appDirOf, isMockMode, loadConfig, type PatchPilotConfig } from "./config.ts";
import { FINISHED_STAGES, IncidentStore } from "./store.ts";
import { pruneWorktrees } from "./pipeline/sandbox.ts";
import { createIncident, manualEvent, recordOccurrence } from "./capture/incident.ts";
import { computeFingerprint } from "./capture/fingerprint.ts";
import type { Incident, IncidentEvent } from "./types.ts";

const exceptionValueSchema = z.object({
  type: z.string().optional(),
  value: z.string().optional(),
  mechanism: z.unknown().optional(),
  stacktrace: z.unknown().optional(),
});

const incidentEventSchema = z.looseObject({
  event_id: z.string().optional(),
  timestamp: z.string().optional(),
  platform: z.string().optional(),
  exception: z.object({ values: z.array(exceptionValueSchema).min(1) }),
});

const manualBodySchema = z.looseObject({
  repo: z.string().optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  suspectFile: z.string().optional(),
  environment: z.string().optional(),
});

export interface ServerDeps {
  store: IncidentStore;
  config: PatchPilotConfig;
  /** Called (after the HTTP response is sent) for every brand-new incident. */
  onIncident?: (incident: Incident) => Promise<void> | void;
}

export interface ServerHandle {
  app: express.Express;
  store: IncidentStore;
  config: PatchPilotConfig;
  port: number;
}

function normalizeEvent(raw: Record<string, unknown>): IncidentEvent {
  const ev = raw as unknown as IncidentEvent;
  return {
    ...ev,
    event_id: ev.event_id || `ev_${Date.now().toString(36)}`,
    timestamp: ev.timestamp || new Date().toISOString(),
    platform: ev.platform || "node",
  };
}

export function buildApp(deps: ServerDeps): express.Express {
  const { store, config } = deps;
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  /** Runs the pipeline after the response has been sent, never inside the request. */
  const kickOff = (incident: Incident) => {
    setImmediate(() => {
      // Promise.resolve().then(...) so a synchronous throw is caught too.
      void Promise.resolve()
        .then(() => deps.onIncident?.(incident))
        .catch((err: unknown) => {
          const message = (err as Error)?.message ?? String(err);
          // Never leave an incident stuck in a non-terminal stage.
          if (!FINISHED_STAGES.includes(incident.stage)) {
            incident.error = message;
            incident.finishedAt = new Date().toISOString();
            store.setStage(incident, "failed", message);
          } else {
            store.log(incident, "error", `pipeline failed: ${message}`);
          }
        });
    });
  };

  app.get("/api/config", (_req, res) => {
    res.json({
      defaultRepo: config.defaultRepo,
      maxFixAttempts: config.maxFixAttempts,
      minTriageConfidence: config.minTriageConfidence,
      repos: config.repos,
      mock: isMockMode(),
      openPr: process.env.PATCHPILOT_OPEN_PR === "1",
    });
  });

  app.post("/api/incidents", (req, res) => {
    const parsed = incidentEventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "expected an event with exception.values" });
      return;
    }
    const event = normalizeEvent(req.body as Record<string, unknown>);
    const repoName =
      event.tags?.repo && config.repos[event.tags.repo] ? event.tags.repo : config.defaultRepo;
    const repo = config.repos[repoName];
    if (!repo) {
      res.status(400).json({ error: `unknown repo "${repoName}"` });
      return;
    }
    const fingerprint = computeFingerprint(event);

    const existing = store.findByFingerprint(fingerprint, repoName);
    if (existing) {
      recordOccurrence(existing, event);
      store.log(existing, "info", `occurrence #${existing.occurrences}`, { eventId: event.event_id });
      res.status(202).json({ status: "existing", id: existing.id });
      return;
    }

    const incident = createIncident(event, repoName, appDirOf(repo));
    store.add(incident);
    store.log(incident, "event", incident.title, { transaction: event.transaction });
    res.status(201).json({ status: "created", id: incident.id });
    kickOff(incident);
  });

  addManualRoute(app, deps, kickOff);
  addReadRoutes(app, deps);
  return app;
}

function addManualRoute(
  app: express.Express,
  deps: ServerDeps,
  kickOff: (incident: Incident) => void
): void {
  const { store, config } = deps;
  app.post("/api/incidents/manual", (req, res) => {
    const parsed = manualBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "expected { title, description }" });
      return;
    }
    const repoName =
      parsed.data.repo && config.repos[parsed.data.repo] ? parsed.data.repo : config.defaultRepo;
    const repo = config.repos[repoName];
    if (!repo) {
      res.status(400).json({ error: `unknown repo "${repoName}"` });
      return;
    }
    const event = manualEvent({ ...parsed.data, repo: repoName });
    const fingerprint = computeFingerprint(event);
    const existing = store.findByFingerprint(fingerprint, repoName);
    if (existing) {
      recordOccurrence(existing, event);
      store.log(existing, "info", `occurrence #${existing.occurrences}`, { source: "manual" });
      res.status(202).json({ status: "existing", id: existing.id });
      return;
    }
    const incident = createIncident(event, repoName, appDirOf(repo));
    incident.description = parsed.data.description;
    incident.suspectFile = parsed.data.suspectFile;
    store.add(incident);
    store.log(incident, "event", incident.title, { source: "manual" });
    res.status(201).json({ status: "created", id: incident.id });
    kickOff(incident);
  });
}

function addReadRoutes(app: express.Express, deps: ServerDeps): void {
  const { store } = deps;

  app.get("/api/incidents", (_req, res) => {
    res.json({ incidents: store.list() });
  });

  app.get("/api/incidents/:id", (req, res) => {
    const incident = store.get(req.params.id);
    if (!incident) {
      res.status(404).json({ error: "no such incident" });
      return;
    }
    res.json(incident);
  });

  app.get("/api/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.write("event: ready\ndata: {}\n\n");

    const onReady = (payload: unknown) => {
      res.write(`event: incident\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    store.on("event", onReady);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      store.off("event", onReady);
    };
    req.on("close", () => {
      cleanup();
      res.end();
    });
    req.on("error", cleanup);
  });

  // Unknown API paths answer JSON, not Express's HTML page.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "no such endpoint" });
  });

  app.use(express.static(path.join(PROJECT_ROOT, "dashboard")));

  // Malformed bodies and other 4xx errors should answer JSON, not Express's HTML page.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const anyErr = err as { status?: number; statusCode?: number; message?: string };
    const raw = anyErr?.status ?? anyErr?.statusCode ?? 500;
    const status = raw >= 400 && raw < 600 ? raw : 500;
    res.status(status).json({ error: anyErr?.message ?? "internal error" });
  });
}


export function startServer(overrides: Partial<ServerDeps> = {}): ServerHandle {
  const config = overrides.config ?? loadConfig();
  const store = overrides.store ?? new IncidentStore();
  store.load();
  // Stale worktree records from a killed run would otherwise linger forever.
  for (const repo of Object.values(config.repos)) pruneWorktrees(repo);
  const deps: ServerDeps = { store, config, onIncident: overrides.onIncident };
  const app = buildApp(deps);
  const port = SERVER_PORT;

  const server = app.listen(port, (err?: Error) => {
    if (err) {
      const code = (err as NodeJS.ErrnoException).code ?? err.message;
      console.error(`could not start on port ${port}: ${code}`);
      process.exit(1);
    }
    console.log(`PatchPilot listening on http://localhost:${port}`);
    console.log(`dashboard: http://localhost:${port}/`);
    if (isMockMode()) console.log("mock mode: no model calls will be made");
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`could not start on port ${port}: ${err.code ?? err.message}`);
    process.exit(1);
  });

  return { app, store, config, port };
}

