import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  LinqMediaPart,
  LinqMessageReceivedData,
  LinqReactionReceivedData,
  LinqTextPart,
  LinqWebhookEvent,
} from "./types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions, waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { resolveLinqAccount } from "./accounts.js";
import { markAsReadLinq, sendMessageLinq, startTypingLinq } from "./send.js";
import { getLinqRuntime } from "../runtime.js";
import { createLinqWebhookHandler, createMemoryLinqWebhookDedupeStore } from "./webhook.js";

const LINQ_WEBHOOK_MAX_BYTES = 1024 * 1024;
const LINQ_WEBHOOK_REPLAY_WINDOW_SECONDS = 300;
const LINQ_WEBHOOK_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const activeWebhookPaths = new Map<string, string>();

export type MonitorLinqOpts = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: { info: (msg: string) => void; error?: (msg: string) => void };
  abortSignal?: AbortSignal;
};

function normalizeAllowList(raw?: Array<string | number>): string[] {
  if (!raw || !Array.isArray(raw)) {
    return [];
  }
  return raw.map((v) => String(v).trim()).filter(Boolean);
}

function extractTextContent(parts: Array<{ type: string; value?: string }>): string {
  return parts
    .filter((p): p is LinqTextPart => p.type === "text")
    .map((p) => p.value)
    .join("\n");
}

function extractMediaUrls(
  parts: Array<{ type: string; url?: string; mime_type?: string }>,
): Array<{ url: string; mimeType: string }> {
  return parts
    .filter(
      (p): p is LinqMediaPart & { url: string; mime_type: string } =>
        p.type === "media" && Boolean(p.url) && Boolean(p.mime_type),
    )
    .map((p) => ({ url: p.url, mimeType: p.mime_type }));
}

export function normalizeLinqMessageReceivedData(raw: unknown): LinqMessageReceivedData | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const data = raw as Record<string, unknown>;
  const legacyMessage = data.message as { id?: unknown; parts?: unknown; reply_to?: unknown } | undefined;
  if (
    typeof data.chat_id === "string" &&
    typeof data.from === "string" &&
    legacyMessage &&
    typeof legacyMessage.id === "string" &&
    Array.isArray(legacyMessage.parts)
  ) {
    return data as LinqMessageReceivedData;
  }

  const chat = data.chat as
    | {
        id?: unknown;
        owner_handle?: { handle?: unknown };
      }
    | undefined;
  const senderHandle = data.sender_handle as { handle?: unknown; is_me?: unknown } | undefined;
  if (
    typeof chat?.id !== "string" ||
    typeof senderHandle?.handle !== "string" ||
    !Array.isArray(data.parts) ||
    typeof data.id !== "string"
  ) {
    return null;
  }

  return {
    chat_id: chat.id,
    from: senderHandle.handle,
    recipient_phone:
      typeof chat.owner_handle?.handle === "string" ? chat.owner_handle.handle : "",
    received_at:
      typeof data.sent_at === "string"
        ? data.sent_at
        : typeof data.created_at === "string"
          ? data.created_at
          : "",
    is_from_me:
      data.direction === "outbound" ||
      senderHandle.is_me === true,
    service:
      data.service === "SMS" || data.service === "RCS" || data.service === "iMessage"
        ? data.service
        : "iMessage",
    message: {
      id: data.id,
      parts: data.parts as LinqMessageReceivedData["message"]["parts"],
      reply_to: data.reply_to as LinqMessageReceivedData["message"]["reply_to"],
    },
  };
}

function isAllowedLinqSender(allowFrom: string[], sender: string): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalized = sender.replace(/[\s()-]/g, "").toLowerCase();
  return allowFrom.some((entry) => {
    const norm = entry.replace(/[\s()-]/g, "").toLowerCase();
    return norm === normalized;
  });
}

export async function monitorLinqProvider(opts: MonitorLinqOpts = {}): Promise<void> {
  const rt = getLinqRuntime();
  const logVerbose = (msg: string) => {
    if (rt.logging.shouldLogVerbose()) {
      opts.runtime?.info(msg);
    }
  };
  const cfg = opts.config ?? rt.config.loadConfig();
  const accountInfo = resolveLinqAccount({ cfg, accountId: opts.accountId });
  const linqCfg = accountInfo.config;
  const token = accountInfo.token;

  if (!token) {
    throw new Error("Linq API token not configured");
  }

  const allowFrom = normalizeAllowList(linqCfg.allowFrom);
  const dmPolicy = linqCfg.dmPolicy ?? "open";
  const webhookSecret = accountInfo.webhookSecret;
  const webhookPath = linqCfg.webhookPath?.trim() || "/linq-webhook";
  const fromPhone = accountInfo.fromPhone;

  const inboundDebounceMs = rt.channel.debounce.resolveInboundDebounceMs({ cfg, channel: "linq" });
  const inboundDebouncer = rt.channel.debounce.createInboundDebouncer<{ event: LinqMessageReceivedData }>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const sender = entry.event.from?.trim();
      if (!sender) {
        return null;
      }
      return `linq:${accountInfo.accountId}:${entry.event.chat_id}:${sender}`;
    },
    shouldDebounce: (entry) => {
      const text = extractTextContent(
        entry.event.message.parts as Array<{ type: string; value?: string }>,
      );
      if (!text.trim()) {
        return false;
      }
      return !rt.channel.text.hasControlCommand(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleMessage(last.event);
        return;
      }
      const combinedText = entries
        .map((e) =>
          extractTextContent(e.event.message.parts as Array<{ type: string; value?: string }>),
        )
        .filter(Boolean)
        .join("\n");
      const syntheticEvent: LinqMessageReceivedData = {
        ...last.event,
        message: {
          ...last.event.message,
          parts: [{ type: "text" as const, value: combinedText }],
        },
      };
      await handleMessage(syntheticEvent);
    },
    onError: (err) => {
      opts.runtime?.error?.(`linq debounce flush failed: ${String(err)}`);
    },
  });

  async function handleMessage(data: LinqMessageReceivedData) {
    const sender = data.from?.trim();
    if (!sender) {
      return;
    }
    if (data.is_from_me) {
      return;
    }

    if (fromPhone && data.recipient_phone !== fromPhone) {
      logVerbose(`linq: skipping message to ${data.recipient_phone} (not ${fromPhone})`);
      return;
    }

    const chatId = data.chat_id;
    const text = extractTextContent(data.message.parts as Array<{ type: string; value?: string }>);
    const media = extractMediaUrls(
      data.message.parts as Array<{ type: string; url?: string; mime_type?: string }>,
    );

    if (!text.trim() && media.length === 0) {
      return;
    }

    markAsReadLinq(chatId, token);
    startTypingLinq(chatId, token);

    const storeAllowFrom = await rt.channel.pairing
      .readAllowFromStore({ channel: "linq", accountId: accountInfo.accountId })
      .catch(() => []);
    const effectiveDmAllowFrom = Array.from(new Set([...allowFrom, ...storeAllowFrom]))
      .map((v) => String(v).trim())
      .filter(Boolean);

    const dmHasWildcard = effectiveDmAllowFrom.includes("*");
    const dmAuthorized =
      dmPolicy === "open"
        ? true
        : dmHasWildcard ||
          (effectiveDmAllowFrom.length > 0 && isAllowedLinqSender(effectiveDmAllowFrom, sender));

    if (dmPolicy === "disabled") {
      return;
    }
    if (!dmAuthorized) {
      if (dmPolicy === "pairing") {
        const { code, created } = await rt.channel.pairing.upsertPairingRequest({
          channel: "linq",
          id: sender,
          accountId: accountInfo.accountId,
          meta: { sender, chatId },
        });
        if (created) {
          logVerbose(`linq pairing request sender=${sender}`);
          try {
            await sendMessageLinq(
              `linq:chat:${chatId}`,
              rt.channel.pairing.buildPairingReply({
                channel: "linq",
                idLine: `Your phone number: ${sender}`,
                code,
              }),
              { token, accountId: accountInfo.accountId },
            );
          } catch (err) {
            logVerbose(`linq pairing reply failed for ${sender}: ${String(err)}`);
          }
        }
      } else {
        logVerbose(`Blocked linq sender ${sender} (dmPolicy=${dmPolicy})`);
      }
      return;
    }

    const route = rt.channel.routing.resolveAgentRoute({
      cfg,
      channel: "linq",
      accountId: accountInfo.accountId,
      peer: { kind: "direct", id: sender },
    });
    const bodyText = text.trim() || (media.length > 0 ? "<media:image>" : "");
    if (!bodyText) {
      return;
    }

    const replyContext = data.message.reply_to ? { id: data.message.reply_to.message_id } : null;
    const createdAt = data.received_at ? Date.parse(data.received_at) : undefined;

    const fromLabel = sender;
    const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
    const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp = rt.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });

    const replySuffix = replyContext?.id ? `\n\n[Replying to message ${replyContext.id}]` : "";
    const body = rt.channel.reply.formatInboundEnvelope({
      channel: "Linq iMessage",
      from: fromLabel,
      timestamp: createdAt,
      body: `${bodyText}${replySuffix}`,
      chatType: "direct",
      sender: { name: sender, id: sender },
      previousTimestamp,
      envelope: envelopeOptions,
    });

    const linqTo = chatId;
    const ctxPayload = rt.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: bodyText,
      RawBody: bodyText,
      CommandBody: bodyText,
      From: `linq:${sender}`,
      To: linqTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: "direct",
      ConversationLabel: fromLabel,
      SenderName: sender,
      SenderId: sender,
      Provider: "linq",
      Surface: "linq",
      MessageSid: data.message.id,
      ReplyToId: replyContext?.id,
      Timestamp: createdAt,
      MediaUrl: media[0]?.url,
      MediaType: media[0]?.mimeType,
      MediaUrls: media.length > 0 ? media.map((m) => m.url) : undefined,
      MediaTypes: media.length > 0 ? media.map((m) => m.mimeType) : undefined,
      WasMentioned: true,
      CommandAuthorized: dmAuthorized,
      OriginatingChannel: "linq" as const,
      OriginatingTo: linqTo,
    });

    await rt.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey: route.mainSessionKey,
        channel: "linq",
        to: linqTo,
        accountId: route.accountId,
      },
      onRecordError: (err) => {
        logVerbose(`linq: failed updating session meta: ${String(err)}`);
      },
    });

    logVerbose(
      `linq inbound: chatId=${chatId} from=${sender} len=${body.length}`,
    );

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "linq",
      accountId: route.accountId,
    });

    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload) => {
          const replyText = typeof payload === "string" ? payload : (payload.text ?? "");
          if (replyText) {
            await sendMessageLinq(`linq:chat:${chatId}`, replyText, {
              token,
              accountId: accountInfo.accountId,
            });
          }
        },
      },
    });
  }

  const webhookHandler = createLinqWebhookHandler({
    path: webhookPath,
    secret: webhookSecret,
    maxBytes: LINQ_WEBHOOK_MAX_BYTES,
    replayWindowSeconds: LINQ_WEBHOOK_REPLAY_WINDOW_SECONDS,
    dedupeTtlMs: LINQ_WEBHOOK_DEDUPE_TTL_MS,
    dedupeStore: createMemoryLinqWebhookDedupeStore(),
  });

  const currentPathOwner = activeWebhookPaths.get(webhookPath);
  if (currentPathOwner && currentPathOwner !== accountInfo.accountId) {
    throw new Error(
      `Linq webhook path ${webhookPath} is already registered by account ${currentPathOwner}; configure a distinct webhookPath for account ${accountInfo.accountId}.`,
    );
  }

  const unregister = registerPluginHttpRoute({
    path: webhookPath,
    auth: "plugin",
    pluginId: "linq",
    accountId: accountInfo.accountId,
    replaceExisting: true,
    log: (msg) => opts.runtime?.info(msg),
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      const chunks: Buffer[] = [];
      let size = 0;
      const maxPayloadBytes = LINQ_WEBHOOK_MAX_BYTES;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > maxPayloadBytes) {
          res.writeHead(413);
          res.end();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const result = await webhookHandler({
        method: req.method ?? "GET",
        path: url.pathname,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });

      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.body);

      if (!result.event || result.duplicate) {
        return;
      }

      try {
        const event = result.event as LinqWebhookEvent;
        if (event.event_type === "message.received") {
          const data = normalizeLinqMessageReceivedData(event.data);
          if (!data) {
            logVerbose(`linq webhook ignored malformed message.received event ${event.event_id}`);
            return;
          }
          await inboundDebouncer.enqueue({ event: data });
        } else if (event.event_type === "reaction.received") {
          const data = event.data as LinqReactionReceivedData;
          if (!data.is_from_me && data.reaction) {
            logVerbose(
              `linq reaction: ${data.reaction.operation} ${data.reaction.type} from=${data.from} msg=${data.message_id}`,
            );
          }
        } else if (event.event_type === "message.delivery_status") {
          logVerbose(`linq delivery: ${(event.data as { status?: string })?.status} msg=${(event.data as { message_id?: string })?.message_id}`);
        }
      } catch (err) {
        opts.runtime?.error?.(`linq webhook parse error: ${String(err)}`);
      }
    },
  });
  activeWebhookPaths.set(webhookPath, accountInfo.accountId);
  opts.runtime?.info(`linq: registered webhook route ${webhookPath} for account ${accountInfo.accountId}`);
  await waitUntilAbort(opts.abortSignal, () => {
    unregister();
    if (activeWebhookPaths.get(webhookPath) === accountInfo.accountId) {
      activeWebhookPaths.delete(webhookPath);
    }
  });
}
