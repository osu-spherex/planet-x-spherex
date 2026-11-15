// Waking the backend when a visitor opens the site.
//
// The backend runs on a free Render instance that sleeps after 15 minutes without requests and
// takes up to a minute to wake (deploy/wake.md). The five demo objects do not need it, but a typed
// position does. One request to /health on page load starts the wake-up while the visitor is still
// reading, so the wait is over (or shorter) by the time they submit coordinates.
// Fire and forget: nothing on the page depends on the answer.

import { backendBase } from "./backend";

/** URL to request, or null when no backend is configured. */
export function wakeUrl(base: string | null = backendBase()): string | null {
  return base ? `${base}/health` : null;
}

/** Send one wake-up request. Never throws and never rejects. Returns whether a request was sent. */
export function wakeBackend(base: string | null = backendBase(), fetchImpl: typeof fetch = fetch): boolean {
  const url = wakeUrl(base);
  if (!url) return false;
  try {
    // no-cors: the answer is not read, so the request must not depend on the CORS settings.
    void Promise.resolve(fetchImpl(url, { mode: "no-cors", cache: "no-store" })).catch(() => {});
  } catch {
    return false;
  }
  return true;
}
