import { DEFAULT_ACCOUNT_ID, type ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedLinqAccount } from "./linq/accounts.js";
import type { LinqProbe } from "./linq/types.js";
import { resolveLinqAccount } from "./linq/accounts.js";
import { probeLinq } from "./linq/probe.js";
import { sendMessageLinq } from "./linq/send.js";
import { formatLinqTarget, parseLinqTarget } from "./linq/targets.js";
import { monitorLinqProvider } from "./linq/gateway.js";
import { linqMessageAdapter, toLinqOutboundDeliveryResult } from "./linq/message.js";
import { resolveLinqOutboundSessionRoute } from "./linq/session-route.js";
import { getLinqRuntime } from "./runtime.js";
import { createLinqPluginBase } from "./channel-base.js";

export const linqPlugin: ChannelPlugin<ResolvedLinqAccount, LinqProbe> = {
  ...createLinqPluginBase(),
  pairing: {
    idLabel: "phoneNumber",
    notifyApproval: async ({ id, accountId, cfg }) => {
      const account = resolveLinqAccount({ cfg, accountId });
      await sendMessageLinq(`linq:${id}`, "Pairing approved. You can now message this agent.", {
        account,
        accountId: account.accountId,
      });
    },
  },
  messaging: {
    normalizeTarget: (raw: string) => {
      if (!raw) {
        return "";
      }
      try {
        return formatLinqTarget(parseLinqTarget(raw));
      } catch {
        return raw;
      }
    },
    resolveOutboundSessionRoute: (params) => resolveLinqOutboundSessionRoute(params),
    targetResolver: {
      looksLikeId: (id) => {
        try {
          parseLinqTarget(id ?? "");
          return true;
        } catch {
          return false;
        }
      },
      hint: "linq:+15556667777 | linq:chat:<chat_id> | linq:<accountId>:+15556667777",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getLinqRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const cfg = getLinqRuntime().config.current() as OpenClawConfig;
      const result = await sendMessageLinq(to, text, {
        accountId: accountId ?? undefined,
        config: cfg,
      });
      return toLinqOutboundDeliveryResult(result, "text");
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const cfg = getLinqRuntime().config.current() as OpenClawConfig;
      const result = await sendMessageLinq(to, text, {
        mediaUrl,
        accountId: accountId ?? undefined,
        config: cfg,
      });
      return toLinqOutboundDeliveryResult(result, "media");
    },
  },
  message: linqMessageAdapter,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) {
          return [];
        }
        return [
          {
            channel: "linq",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      webhookSecretSource:
        ((snapshot as Record<string, unknown>).webhookSecretSource as string | undefined) ?? "none",
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => probeLinq(account.token, timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
      webhookSecretSource: account.webhookSecretSource,
      fromPhone: account.fromPhone,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();
      let phoneLabel = "";
      try {
        const probe = await probeLinq(token, 2500);
        if (probe.ok && probe.phoneNumbers?.length) {
          phoneLabel = ` (${probe.phoneNumbers.join(", ")})`;
        }
      } catch {
        // Probe failure is non-fatal for startup.
      }
      ctx.log?.info(`[${account.accountId}] starting Linq provider${phoneLabel}`);
      return monitorLinqProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.log,
        abortSignal: ctx.abortSignal,
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const rt = getLinqRuntime();
      const nextCfg = { ...cfg };
      const linqSection = (cfg.channels as Record<string, unknown> | undefined)?.linq as
        | Record<string, unknown>
        | undefined;
      let cleared = false;
      let changed = false;
      if (linqSection) {
        const nextLinq = { ...linqSection };
        if (accountId === DEFAULT_ACCOUNT_ID && nextLinq.apiToken) {
          delete nextLinq.apiToken;
          cleared = true;
          changed = true;
        }
        const accounts =
          nextLinq.accounts && typeof nextLinq.accounts === "object"
            ? { ...(nextLinq.accounts as Record<string, unknown>) }
            : undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId];
          if (entry && typeof entry === "object") {
            const nextEntry = { ...(entry as Record<string, unknown>) };
            if ("apiToken" in nextEntry) {
              cleared = true;
              delete nextEntry.apiToken;
              changed = true;
            }
            if (Object.keys(nextEntry).length === 0) {
              delete accounts[accountId];
              changed = true;
            } else {
              accounts[accountId] = nextEntry;
            }
          }
        }
        if (accounts) {
          if (Object.keys(accounts).length === 0) {
            delete nextLinq.accounts;
            changed = true;
          } else {
            nextLinq.accounts = accounts;
          }
        }
        if (changed) {
          if (Object.keys(nextLinq).length > 0) {
            nextCfg.channels = { ...nextCfg.channels, linq: nextLinq } as typeof nextCfg.channels;
          } else {
            const nextChannels = { ...nextCfg.channels } as Record<string, unknown>;
            delete nextChannels.linq;
            nextCfg.channels = nextChannels as typeof nextCfg.channels;
          }
        }
      }
      if (changed) {
        await rt.config.writeConfigFile(nextCfg);
      }
      const resolved = resolveLinqAccount({ cfg: changed ? nextCfg : cfg, accountId });
      return { cleared, loggedOut: resolved.tokenSource === "none" };
    },
  },
};
