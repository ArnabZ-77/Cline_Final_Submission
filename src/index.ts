/**
 * PatchPilot entry point: start the HTTP server with the pipeline attached.
 */
import { startServer } from "./server.ts";
import { isMockMode, loadConfig, resolveModelSettings } from "./config.ts";
import { IncidentStore } from "./store.ts";
import { processIncident } from "./pipeline/orchestrator.ts";

const config = loadConfig();
const store = new IncidentStore();

// Fail at startup, not on the first crash, when the provider would bypass the guardrails
// (trap 17) or no key is set for a real run.
let settings;
try {
  settings = resolveModelSettings();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
if (isMockMode()) {
  console.log("model: mock fixtures (PATCHPILOT_MOCK=1)");
} else {
  console.log(`model: ${settings.providerId}/${settings.modelId}${settings.fallbackModelId ? ` (fallback ${settings.fallbackModelId})` : ""}`);
  if (!settings.apiKey && settings.providerId !== "ollama") {
    console.warn(`warning: no API key found for provider "${settings.providerId}"; incidents will fail until one is set in .env`);
  }
}

const handle = startServer({
  config,
  store,
  onIncident: (incident) => processIncident(incident, { store, config, settings }).then(() => undefined),
});

export { handle };
