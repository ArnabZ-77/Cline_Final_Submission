/**
 * Small HTTP helpers shared by the demo scripts.
 */
export const DEMO_URL = (process.env.DEMO_URL || "http://localhost:5050").replace(/\/+$/, "");
export const PATCHPILOT_URL = (process.env.PATCHPILOT_URL || "http://localhost:4747").replace(/\/+$/, "");

export interface DemoRequest {
  method: string;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export interface DemoResponse {
  status: number;
  body: unknown;
  text: string;
}

export async function send(base: string, req: DemoRequest, vars: Record<string, string> = {}): Promise<DemoResponse> {
  let p = req.path;
  for (const [k, v] of Object.entries(vars)) p = p.replace(`{${k}}`, encodeURIComponent(v));
  const url = new URL(base + p);
  // URLSearchParams percent-encodes values such as "$19.99" and JSON arrays.
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: req.method,
    headers: req.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep the raw text
  }
  return { status: res.status, body, text };
}

/** A friendlier message than "fetch failed" when a server is not running. */
export function explainFetchError(err: unknown, base: string, startHint: string): string {
  const msg = err instanceof Error ? `${err.message}${(err as { cause?: { code?: string } }).cause?.code ? ` (${(err as { cause?: { code?: string } }).cause!.code})` : ""}` : String(err);
  return `could not reach ${base}: ${msg}. Is it running? Start it with: ${startHint}`;
}
