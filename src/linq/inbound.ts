import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedLinqAccount } from "./accounts.js";
import { authorizeLinqSender, issueLinqPairingChallenge, type LinqChannelRuntime } from "./ingress.js";
import { markAsReadLinq, sendMessageLinq, startTypingLinq, stopTypingLinq } from "./send.js";
import type { LinqMediaPart, LinqMessageReceivedData, LinqTextPart } from "./types.js";

const CHANNEL_ID = "linq";

type LinqLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export function extractLinqText(parts: Array<{ type: string; value?: string }>): string {
  return parts
    .filter((part): part is LinqTextPart => part.type === "text")
    .map((part) => part.value)
    .join("\n");
}

function extractLinqMedia(
  parts: Array<{ type: string; url?: string; mime_type?: string }>,
): Array<{ url: string; mimeType: string }> {
  return parts
    .filter(
      (part): part is LinqMediaPart & { url: string; mime_type: string } =>
        part.type === "media" && Boolean(part.url) && Boolean(part.mime_type),
    )
    .map((part) => ({ url: part.url, mimeType: part.mime_type }));
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
    | { id?: unknown; owner_handle?: { handle?: unknown } }
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
    recipient_phone: typeof chat.owner_handle?.handle === "string" ? chat.owner_handle.handle : "",
    received_at:
      typeof data.sent_at === "string"
        ? data.sent_at
        : typeof data.created_at === "string"
          ? data.created_at
          : "",
    is_from_me: data.direction === "outbound" || senderHandle.is_me === true,
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

function parseLinqTimestamp(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export async function dispatchLinqInboundEvent(params: {
  cfg: OpenClawConfig;
  account: ResolvedLinqAccount;
  message: LinqMessageReceivedData;
  channelRuntime: LinqChannelRuntime;
  log?: LinqLog;
}): Promise<void> {
  const sender = params.message.from?.trim();
  if (!sender || params.message.is_from_me) {
    return;
  }
  if (params.account.fromPhone && params.message.recipient_phone !== params.account.fromPhone) {
    params.log?.info?.(
      `linq: skipping message to ${params.message.recipient_phone} (not ${params.account.fromPhone})`,
    );
    return;
  }

  const text = extractLinqText(
    params.message.message.parts as Array<{ type: string; value?: string }>,
  );
  const media = extractLinqMedia(
    params.message.message.parts as Array<{ type: string; url?: string; mime_type?: string }>,
  );
  if (!text.trim() && media.length === 0) {
    return;
  }

  const authorization = await authorizeLinqSender({
    cfg: params.cfg,
    account: params.account,
    channelRuntime: params.channelRuntime,
    sender,
  });
  if (!authorization.senderAccess.allowed) {
    if (authorization.senderAccess.decision === "pairing") {
      await issueLinqPairingChallenge({
        account: params.account,
        channelRuntime: params.channelRuntime,
        sender,
        chatId: params.message.chat_id,
        log: params.log,
      });
    } else {
      params.log?.warn?.(
        `linq sender ${sender} is not authorized (${authorization.senderAccess.reasonCode})`,
      );
    }
    return;
  }

  const route = params.channelRuntime.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: { kind: "direct", id: sender },
  });
  const replyTarget = `linq:chat:${params.message.chat_id}`;
  const timestamp = parseLinqTimestamp(params.message.received_at);
  const bodyText = text.trim() || "<media:image>";

  void markAsReadLinq(params.message.chat_id, params.account.token);
  void startTypingLinq(params.message.chat_id, params.account.token);

  try {
    await params.channelRuntime.inbound.run({
      channel: CHANNEL_ID,
      accountId: params.account.accountId,
      raw: params.message,
      adapter: {
        ingest: (message) => ({
          id: message.message.id,
          timestamp,
          rawText: bodyText,
          textForAgent: bodyText,
          textForCommands: bodyText,
          raw: message,
        }),
        resolveTurn: async (input) => {
          const ctxPayload = params.channelRuntime.inbound.buildContext({
            channel: CHANNEL_ID,
            accountId: route.accountId,
            messageId: params.message.message.id,
            timestamp: input.timestamp,
            from: `linq:${sender}`,
            sender: { id: sender, name: sender },
            conversation: { kind: "direct", id: sender, label: sender },
            route: {
              agentId: route.agentId,
              accountId: route.accountId,
              routeSessionKey: route.sessionKey,
              dispatchSessionKey: route.sessionKey,
              mainSessionKey: route.mainSessionKey,
            },
            reply: { to: replyTarget, originatingTo: replyTarget },
            message: {
              rawBody: input.rawText,
              commandBody: input.textForCommands,
              bodyForAgent: input.textForAgent,
            },
            media:
              media.length > 0
                ? media.map((item) => ({ url: item.url, contentType: item.mimeType }))
                : undefined,
            extra: {
              ReplyToId: params.message.message.reply_to?.message_id,
              Service: params.message.service,
              WasMentioned: true,
              CommandAuthorized: true,
            },
          });
          const storePath = params.channelRuntime.session.resolveStorePath(
            params.cfg.session?.store,
            { agentId: route.agentId },
          );
          return {
            cfg: params.cfg,
            channel: CHANNEL_ID,
            accountId: route.accountId,
            agentId: route.agentId,
            routeSessionKey: route.sessionKey,
            storePath,
            ctxPayload,
            recordInboundSession: params.channelRuntime.session.recordInboundSession,
            dispatchReplyWithBufferedBlockDispatcher:
              params.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
            record: {
              updateLastRoute: {
                sessionKey: route.mainSessionKey,
                channel: CHANNEL_ID,
                to: replyTarget,
                accountId: route.accountId,
              },
              onRecordError: (err) => {
                params.log?.warn?.(`linq failed updating session metadata: ${String(err)}`);
              },
            },
            delivery: {
              durable: () => ({ to: replyTarget }),
              deliver: async (payload) => {
                const replyText = payload.text ?? "";
                const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];
                if (!replyText && !mediaUrl) {
                  return { visibleReplySent: false };
                }
                await sendMessageLinq(replyTarget, replyText, {
                  account: params.account,
                  mediaUrl,
                });
                return { visibleReplySent: true };
              },
            },
            replyPipeline: {},
            dispatcherOptions: {
              onReplyStart: () => {
                params.log?.info?.(`linq reply started for ${sender}`);
              },
            },
          };
        },
      },
    });
  } finally {
    void stopTypingLinq(params.message.chat_id, params.account.token);
  }
}
