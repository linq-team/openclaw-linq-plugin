import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLinqWebhookHandler, createMemoryLinqWebhookDedupeStore } from "./webhook.js";

const event = {
  api_version: "v3",
  event_id: "evt_1",
  created_at: "2026-06-04T12:00:00Z",
  trace_id: "trace_1",
  partner_id: "partner_1",
  event_type: "message.received",
  data: {},
};

function signedHeaders(secret: string, body: string, timestamp: string) {
  return {
    "x-webhook-timestamp": timestamp,
    "x-webhook-signature": createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex"),
  };
}

describe("createLinqWebhookHandler", () => {
  it("rejects invalid method, oversized body, malformed JSON, and missing event_id", async () => {
    const handle = createLinqWebhookHandler({ path: "/linq", maxBytes: 8 });
    await expect(handle({ method: "GET", path: "/linq", headers: {}, body: "" })).resolves.toMatchObject({
      status: 405,
    });
    await expect(
      handle({ method: "POST", path: "/linq", headers: {}, body: "012345678" }),
    ).resolves.toMatchObject({ status: 413 });

    const parseHandle = createLinqWebhookHandler({ path: "/linq" });
    await expect(
      parseHandle({ method: "POST", path: "/linq", headers: {}, body: "{" }),
    ).resolves.toMatchObject({ status: 400, body: "malformed json" });
    await expect(
      parseHandle({ method: "POST", path: "/linq", headers: {}, body: "{}" }),
    ).resolves.toMatchObject({ status: 400, body: "missing event_id" });
  });

  it("verifies signatures and rejects stale timestamps", async () => {
    const secret = "shh";
    const body = JSON.stringify(event);
    const handle = createLinqWebhookHandler({
      path: "/linq",
      secret,
      now: () => 1_000_000,
      replayWindowSeconds: 300,
    });

    await expect(
      handle({ method: "POST", path: "/linq", headers: {}, body }),
    ).resolves.toMatchObject({ status: 401, body: "missing signature" });
    await expect(
      handle({
        method: "POST",
        path: "/linq",
        headers: signedHeaders(secret, body, "1"),
        body,
      }),
    ).resolves.toMatchObject({ status: 401, body: "stale timestamp" });
    await expect(
      handle({
        method: "POST",
        path: "/linq",
        headers: signedHeaders(secret, body, "1000"),
        body: JSON.stringify({ ...event, event_id: "evt_2" }),
      }),
    ).resolves.toMatchObject({ status: 401, body: "invalid signature" });
    await expect(
      handle({
        method: "POST",
        path: "/linq",
        headers: signedHeaders(secret, body, "1000"),
        body,
      }),
    ).resolves.toMatchObject({ status: 200, event });
  });

  it("acknowledges duplicate event_id values without returning an event", async () => {
    const store = createMemoryLinqWebhookDedupeStore();
    const handle = createLinqWebhookHandler({ path: "/linq", dedupeStore: store });
    const first = await handle({
      method: "POST",
      path: "/linq",
      headers: {},
      body: JSON.stringify(event),
    });
    expect(first).toMatchObject({ status: 200, event });
    expect(first.duplicate).toBeUndefined();
    const duplicate = await handle({
      method: "POST",
      path: "/linq",
      headers: {},
      body: JSON.stringify(event),
    });
    expect(duplicate).toMatchObject({ status: 200, duplicate: true });
    expect(duplicate.event).toBeUndefined();
  });
});
