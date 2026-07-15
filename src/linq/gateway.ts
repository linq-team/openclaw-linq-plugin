import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { getLinqRuntime } from "../runtime.js";
import { resolveLinqAccount } from "./accounts.js";
import { dispatchLinqInboundEvent, extractLinqText, normalizeLinqMessageReceivedData } from "./inbound.js";
import type { LinqMessageReceivedData, LinqReactionReceivedData, LinqWebhookEvent } from "./types.js";
import { createLinqWebhookHandler, createMemoryLinqWebhookDedupeStore } from "./webhook.js";

const LINQ_WEBHOOK_MAX_BYTES = 1024 * 1024;
const LINQ_WEBHOOK_REPLAY_WINDOW_SECONDS = 300;
const LINQ_WEBHOOK_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const activeWebhookPaths = new Map<string, string>();

export type MonitorLinqOpts = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: {
    info: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  abortSignal?: AbortSignal;
};

export async function monitorLinqProvider(opts: MonitorLinqOpts = {}): Promise<void> {
  const rt = getLinqRuntime();
  const logVerbose = (message: string) => {
    if (rt.logging.shouldLogVerbose()) {
      opts.runtime?.info(message);
    }
  };
  const cfg = opts.config ?? rt.config.loadConfig();
  const account = resolveLinqAccount({ cfg, accountId: opts.accountId });
  if (!account.token) {
    throw new Error("Linq API token not configured");
  }

  const webhookPath = account.config.webhookPath?.trim() || "/linq-webhook";
  const inboundDebounceMs = rt.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "linq",
  });
  const inboundDebouncer = rt.channel.debounce.createInboundDebouncer<{
    event: LinqMessageReceivedData;
  }>({
    debounceMs: inboundDebounceMs,
    buildKey: ({ event }) => {
      const sender = event.from?.trim();
      return sender ? `linq:${account.accountId}:${event.chat_id}:${sender}` : null;
    },
    shouldDebounce: ({ event }) => {
      const text = extractLinqText(
        event.message.parts as Array<{ type: string; value?: string }>,
      );
      return Boolean(text.trim()) && !rt.channel.text.hasControlCommand(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const event =
        entries.length === 1
          ? last.event
          : {
              ...last.event,
              message: {
                ...last.event.message,
                parts: [
                  {
                    type: "text" as const,
                    value: entries
                      .map(({ event }) =>
                        extractLinqText(
                          event.message.parts as Array<{ type: string; value?: string }>,
                        ),
                      )
                      .filter(Boolean)
                      .join("\n"),
                  },
                ],
              },
            };
      await dispatchLinqInboundEvent({
        cfg,
        account,
        message: event,
        channelRuntime: rt.channel,
        log: { info: logVerbose, warn: opts.runtime?.warn ?? opts.runtime?.error },
      });
    },
    onError: (err) => {
      opts.runtime?.error?.(`linq debounce flush failed: ${String(err)}`);
    },
  });

  const webhookHandler = createLinqWebhookHandler({
    path: webhookPath,
    secret: account.webhookSecret,
    maxBytes: LINQ_WEBHOOK_MAX_BYTES,
    replayWindowSeconds: LINQ_WEBHOOK_REPLAY_WINDOW_SECONDS,
    dedupeTtlMs: LINQ_WEBHOOK_DEDUPE_TTL_MS,
    dedupeStore: createMemoryLinqWebhookDedupeStore(),
  });
  const currentPathOwner = activeWebhookPaths.get(webhookPath);
  if (currentPathOwner && currentPathOwner !== account.accountId) {
    throw new Error(
      `Linq webhook path ${webhookPath} is already registered by account ${currentPathOwner}; configure a distinct webhookPath for account ${account.accountId}.`,
    );
  }

  const unregister = registerPluginHttpRoute({
    path: webhookPath,
    auth: "plugin",
    pluginId: "linq",
    accountId: account.accountId,
    replaceExisting: true,
    log: (message) => opts.runtime?.info(message),
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > LINQ_WEBHOOK_MAX_BYTES) {
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
          const message = normalizeLinqMessageReceivedData(event.data);
          if (!message) {
            logVerbose(`linq webhook ignored malformed message.received event ${event.event_id}`);
            return;
          }
          await inboundDebouncer.enqueue({ event: message });
        } else if (event.event_type === "reaction.received") {
          const reaction = event.data as LinqReactionReceivedData;
          if (!reaction.is_from_me && reaction.reaction) {
            logVerbose(
              `linq reaction: ${reaction.reaction.operation} ${reaction.reaction.type} from=${reaction.from} msg=${reaction.message_id}`,
            );
          }
        } else if (event.event_type === "message.delivery_status") {
          const delivery = event.data as { status?: string; message_id?: string };
          logVerbose(`linq delivery: ${delivery.status} msg=${delivery.message_id}`);
        }
      } catch (err) {
        opts.runtime?.error?.(`linq webhook parse error: ${String(err)}`);
      }
    },
  });

  activeWebhookPaths.set(webhookPath, account.accountId);
  opts.runtime?.info(
    `linq: registered webhook route ${webhookPath} for account ${account.accountId}`,
  );
  await waitUntilAbort(opts.abortSignal, () => {
    unregister();
    if (activeWebhookPaths.get(webhookPath) === account.accountId) {
      activeWebhookPaths.delete(webhookPath);
    }
  });
}
