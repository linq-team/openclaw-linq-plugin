import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedLinqAccount } from "./accounts.js";
import {
  dispatchLinqInboundEvent,
  normalizeLinqMessageReceivedData,
} from "./inbound.js";
import type { LinqChannelRuntime } from "./ingress.js";
import type { LinqMessageReceivedData } from "./types.js";

const sendMessageLinq = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "msg_reply", chatId: "chat_1", target: "linq:chat:chat_1" })),
);
const markAsReadLinq = vi.hoisted(() => vi.fn(async () => true));
const startTypingLinq = vi.hoisted(() => vi.fn(async () => true));
const stopTypingLinq = vi.hoisted(() => vi.fn(async () => true));

vi.mock("./send.js", () => ({
  sendMessageLinq,
  markAsReadLinq,
  startTypingLinq,
  stopTypingLinq,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function createAccount(
  config: ResolvedLinqAccount["config"] = {},
): ResolvedLinqAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "token",
    tokenSource: "config",
    webhookSecret: "secret",
    webhookSecretSource: "config",
    fromPhone: "+15557654321",
    config,
  };
}

function createMessage(): LinqMessageReceivedData {
  return {
    chat_id: "chat_1",
    from: "+15551234567",
    recipient_phone: "+15557654321",
    received_at: "2026-07-13T12:00:00.000Z",
    is_from_me: false,
    service: "iMessage",
    message: {
      id: "msg_inbound",
      parts: [{ type: "text", value: "hello" }],
    },
  };
}

function createRuntime() {
  const readAllowFromStore = vi.fn(async () => [] as string[]);
  const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR123", created: true }));
  const resolveAgentRoute = vi.fn(() => ({
    agentId: "main",
    accountId: "default",
    sessionKey: "agent:main:linq:direct:+15551234567",
    mainSessionKey: "agent:main:main",
  }));
  const run = vi.fn(async () => undefined);
  const buildContext = vi.fn(() => ({
    SessionKey: "agent:main:linq:direct:+15551234567",
  }));
  const resolveStorePath = vi.fn(() => "/tmp/openclaw-sessions");
  const runtime = {
    pairing: { readAllowFromStore, upsertPairingRequest },
    routing: { resolveAgentRoute },
    inbound: { run, buildContext },
    session: { resolveStorePath, recordInboundSession: vi.fn() },
    reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
  } as unknown as LinqChannelRuntime;
  return {
    runtime,
    readAllowFromStore,
    upsertPairingRequest,
    resolveAgentRoute,
    run,
    buildContext,
    resolveStorePath,
  };
}

describe("normalizeLinqMessageReceivedData", () => {
  it("keeps the legacy 2025 message.received shape", () => {
    const data = {
      chat_id: "chat_1",
      from: "+12025550100",
      recipient_phone: "+12025550101",
      received_at: "2026-02-05T19:31:13.736Z",
      is_from_me: false,
      service: "SMS",
      message: {
        id: "msg_1",
        parts: [{ type: "text", value: "hello" }],
      },
    };

    expect(normalizeLinqMessageReceivedData(data)).toEqual(data);
  });

  it("normalizes the current 2026 message.received shape", () => {
    expect(
      normalizeLinqMessageReceivedData({
        chat: {
          id: "chat_2",
          owner_handle: { handle: "+12025550101" },
        },
        id: "msg_2",
        direction: "inbound",
        sender_handle: { handle: "+12025550100", is_me: false },
        parts: [{ type: "text", value: "hello" }],
        sent_at: "2026-02-05T19:31:13.074Z",
        service: "SMS",
      }),
    ).toEqual({
      chat_id: "chat_2",
      from: "+12025550100",
      recipient_phone: "+12025550101",
      received_at: "2026-02-05T19:31:13.074Z",
      is_from_me: false,
      service: "SMS",
      message: {
        id: "msg_2",
        parts: [{ type: "text", value: "hello" }],
      },
    });
  });
});

describe("dispatchLinqInboundEvent", () => {
  it("does not block dispatch on best-effort presence calls", async () => {
    const { runtime, run } = createRuntime();
    markAsReadLinq.mockImplementationOnce(() => new Promise(() => {}));
    startTypingLinq.mockImplementationOnce(() => new Promise(() => {}));

    const outcome = await Promise.race([
      dispatchLinqInboundEvent({
        cfg: {},
        account: createAccount({ dmPolicy: "open" }),
        message: createMessage(),
        channelRuntime: runtime,
      }).then(() => "dispatched"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);

    expect(outcome).toBe("dispatched");
    expect(run).toHaveBeenCalledOnce();
    expect(stopTypingLinq).toHaveBeenCalledOnce();
  });

  it("preserves the legacy open policy without requiring an explicit wildcard", async () => {
    const { runtime, run } = createRuntime();

    await dispatchLinqInboundEvent({
      cfg: {},
      account: createAccount({ dmPolicy: "open" }),
      message: createMessage(),
      channelRuntime: runtime,
    });

    expect(run).toHaveBeenCalledOnce();
  });

  it("creates an account-scoped pairing challenge for unknown senders", async () => {
    const { runtime, readAllowFromStore, upsertPairingRequest, run } = createRuntime();

    await dispatchLinqInboundEvent({
      cfg: {},
      account: createAccount({ dmPolicy: "pairing" }),
      message: createMessage(),
      channelRuntime: runtime,
    });

    expect(readAllowFromStore).toHaveBeenCalledWith({ channel: "linq", accountId: "default" });
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "linq",
      accountId: "default",
      id: "+15551234567",
      meta: { sender: "+15551234567", chatId: "chat_1" },
    });
    expect(sendMessageLinq).toHaveBeenCalledWith(
      "linq:chat:chat_1",
      expect.stringContaining("PAIR123"),
      expect.objectContaining({ account: expect.objectContaining({ accountId: "default" }) }),
    );
    expect(run).not.toHaveBeenCalled();
    expect(startTypingLinq).not.toHaveBeenCalled();
  });

  it("runs authorized messages on the phone session and persists the chat reply target", async () => {
    const { runtime, resolveAgentRoute, run, buildContext, resolveStorePath } = createRuntime();
    const cfg: OpenClawConfig = { session: { dmScope: "per-channel-peer" } };
    const message = createMessage();

    await dispatchLinqInboundEvent({
      cfg,
      account: createAccount({
        dmPolicy: "allowlist",
        allowFrom: ["+1 (555) 123-4567"],
      }),
      message,
      channelRuntime: runtime,
    });

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({ peer: { kind: "direct", id: "+15551234567" } }),
    );
    expect(markAsReadLinq).toHaveBeenCalledWith("chat_1", "token");
    expect(startTypingLinq).toHaveBeenCalledWith("chat_1", "token");
    expect(stopTypingLinq).toHaveBeenCalledWith("chat_1", "token");

    const runParams = run.mock.calls[0]?.[0] as {
      adapter: {
        ingest: (raw: LinqMessageReceivedData) => unknown;
        resolveTurn: (input: unknown) => Promise<{
          routeSessionKey: string;
          record: {
            updateLastRoute: {
              sessionKey: string;
              channel: string;
              to: string;
              accountId: string;
            };
          };
          delivery: {
            durable: () => { to: string };
            deliver: (payload: { text?: string; mediaUrl?: string }) => Promise<{
              visibleReplySent: boolean;
            }>;
          };
          replyPipeline: Record<string, never>;
        }>;
      };
    };
    const input = runParams.adapter.ingest(message);
    const turn = await runParams.adapter.resolveTurn(input);

    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "linq:+15551234567",
        conversation: expect.objectContaining({ id: "+15551234567" }),
        route: expect.objectContaining({
          routeSessionKey: "agent:main:linq:direct:+15551234567",
          dispatchSessionKey: "agent:main:linq:direct:+15551234567",
        }),
        reply: {
          to: "linq:chat:chat_1",
          originatingTo: "linq:chat:chat_1",
        },
      }),
    );
    expect(resolveStorePath).toHaveBeenCalledWith(cfg.session?.store, { agentId: "main" });
    expect(turn.routeSessionKey).toBe("agent:main:linq:direct:+15551234567");
    expect(turn.record.updateLastRoute).toEqual({
      sessionKey: "agent:main:main",
      channel: "linq",
      to: "linq:chat:chat_1",
      accountId: "default",
    });
    expect(turn.delivery.durable()).toEqual({ to: "linq:chat:chat_1" });
    expect(turn.replyPipeline).toEqual({});

    await expect(turn.delivery.deliver({ text: "reply" })).resolves.toEqual({
      visibleReplySent: true,
    });
    expect(sendMessageLinq).toHaveBeenLastCalledWith(
      "linq:chat:chat_1",
      "reply",
      expect.objectContaining({ account: expect.objectContaining({ accountId: "default" }) }),
    );
  });
});
