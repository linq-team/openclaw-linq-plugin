import { createHmac, timingSafeEqual } from "node:crypto";
import type { LinqWebhookEvent } from "./types.js";

export type LinqWebhookDedupeStore = {
  claim: (eventId: string, ttlMs: number) => Promise<boolean> | boolean;
};

export type LinqWebhookRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | string;
};

export type LinqWebhookHandlerOptions = {
  path: string;
  secret?: string;
  maxBytes?: number;
  replayWindowSeconds?: number;
  dedupeTtlMs?: number;
  dedupeStore?: LinqWebhookDedupeStore;
  now?: () => number;
};

export type LinqWebhookHandlerResult = {
  status: number;
  body: string;
  event?: LinqWebhookEvent;
  duplicate?: boolean;
};

function headerValue(headers: LinqWebhookRequest["headers"], name: string): string {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export function verifyWebhookSignature(params: {
  secret: string;
  payload: string;
  timestamp: string;
  signature: string;
}): boolean {
  const message = `${params.timestamp}.${params.payload}`;
  const expected = createHmac("sha256", params.secret).update(message).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(params.signature, "hex"));
  } catch {
    return false;
  }
}

export function createMemoryLinqWebhookDedupeStore(options?: {
  now?: () => number;
}): LinqWebhookDedupeStore & { size: () => number } {
  const entries = new Map<string, number>();
  const now = options?.now ?? Date.now;
  function prune(current: number) {
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= current) {
        entries.delete(key);
      }
    }
  }
  return {
    claim(eventId, ttlMs) {
      const current = now();
      prune(current);
      if (entries.has(eventId)) {
        return false;
      }
      entries.set(eventId, current + ttlMs);
      return true;
    },
    size() {
      prune(now());
      return entries.size;
    },
  };
}

export function createLinqWebhookHandler(options: LinqWebhookHandlerOptions) {
  const webhookPath = options.path || "/linq-webhook";
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const replayWindowSeconds = options.replayWindowSeconds ?? 300;
  const dedupeTtlMs = options.dedupeTtlMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;

  return async (request: LinqWebhookRequest): Promise<LinqWebhookHandlerResult> => {
    if (request.method.toUpperCase() !== "POST") {
      return { status: 405, body: "method not allowed" };
    }
    if (!request.path.startsWith(webhookPath)) {
      return { status: 404, body: "not found" };
    }

    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body);
    if (raw.length > maxBytes) {
      return { status: 413, body: "payload too large" };
    }
    const rawBody = raw.toString("utf8");

    if (options.secret?.trim()) {
      const timestamp = headerValue(request.headers, "x-webhook-timestamp");
      const signature = headerValue(request.headers, "x-webhook-signature");
      if (!timestamp || !signature) {
        return { status: 401, body: "missing signature" };
      }
      const age = Math.abs(now() / 1000 - Number(timestamp));
      if (!Number.isFinite(age) || age > replayWindowSeconds) {
        return { status: 401, body: "stale timestamp" };
      }
      if (
        !verifyWebhookSignature({
          secret: options.secret,
          payload: rawBody,
          timestamp,
          signature,
        })
      ) {
        return { status: 401, body: "invalid signature" };
      }
    }

    let event: LinqWebhookEvent;
    try {
      event = JSON.parse(rawBody) as LinqWebhookEvent;
    } catch {
      return { status: 400, body: "malformed json" };
    }

    const eventId = typeof event.event_id === "string" ? event.event_id.trim() : "";
    if (!eventId) {
      return { status: 400, body: "missing event_id" };
    }
    if (options.dedupeStore) {
      const claimed = await options.dedupeStore.claim(eventId, dedupeTtlMs);
      if (!claimed) {
        return { status: 200, body: JSON.stringify({ received: true, duplicate: true }), duplicate: true };
      }
    }

    return { status: 200, body: JSON.stringify({ received: true }), event };
  };
}
