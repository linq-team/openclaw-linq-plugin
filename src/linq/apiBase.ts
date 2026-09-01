/**
 * Where the Linq partner API lives for this gateway.
 *
 * Originally a module constant read from `process.env.LINQ_API_BASE`. That is
 * only settable when the container is created, and a cell is created BEFORE its
 * iMessage channel is connected — so a pooled-line deployment (MLabRelay, which
 * serves this same API from its own host) could never get the value in: the
 * plugin kept posting the relay's send token to Linq's cloud, which rejects it,
 * and every reply vanished with the agent none the wiser.
 *
 * Config is hot-reloaded, env is not, so `channels.linq.apiBase` is the setting
 * that can actually arrive at the moment the channel is configured. The env var
 * still works and still wins over the built-in default, for anyone already
 * relying on it.
 */
const DEFAULT_LINQ_API_BASE = "https://api.linqapp.com/api/partner/v3";

const trim = (value: string | undefined): string =>
  (value ?? "").trim().replace(/\/+$/, "");

let configured = "";

/** Applied from `channels.linq.apiBase` when a provider starts or reloads. */
export function setLinqApiBase(value?: string): void {
  configured = trim(value);
}

/** `channels.linq.apiBase`, read defensively — this runs during startup and a
 *  malformed config must not take the channel down. */
export function apiBaseFromConfig(cfg: unknown): string | undefined {
  const channels = (cfg as { channels?: Record<string, unknown> } | undefined)?.channels;
  const linq = channels?.linq as { apiBase?: unknown } | undefined;
  return typeof linq?.apiBase === "string" ? linq.apiBase : undefined;
}

export function linqApiBase(): string {
  return configured || trim(process.env.LINQ_API_BASE) || DEFAULT_LINQ_API_BASE;
}
