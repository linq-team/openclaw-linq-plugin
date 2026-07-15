import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/core";
import {
  listLinqAccountIds,
  resolveDefaultLinqAccountId,
  resolveLinqAccountForStatus,
  type ResolvedLinqAccount,
} from "./linq/accounts.js";
import { LinqChannelConfigSchema } from "./linq/config.js";
import {
  collectLinqRuntimeConfigAssignments,
  linqSecretTargetRegistryEntries,
} from "./linq/secret-contract.js";
import type { LinqProbe } from "./linq/types.js";
import { linqOnboardingAdapter } from "./onboarding.js";

const meta = getChatChannelMeta("linq");

export function createLinqPluginBase(): ChannelPlugin<ResolvedLinqAccount, LinqProbe> {
  return {
    id: "linq",
    meta: {
      ...meta,
      aliases: ["linq-imessage"],
    },
    setupWizard: linqOnboardingAdapter,
    capabilities: {
      chatTypes: ["direct"],
      reactions: false,
      media: true,
    },
    reload: { configPrefixes: ["channels.linq"] },
    configSchema: LinqChannelConfigSchema,
    config: {
      listAccountIds: (cfg) => listLinqAccountIds(cfg),
      resolveAccount: (cfg, accountId) => resolveLinqAccountForStatus({ cfg, accountId }),
      defaultAccountId: (cfg) => resolveDefaultLinqAccountId(cfg),
      setAccountEnabled: ({ cfg, accountId, enabled }) =>
        setAccountEnabledInConfigSection({
          cfg,
          sectionKey: "linq",
          accountId,
          enabled,
          allowTopLevel: true,
        }),
      deleteAccount: ({ cfg, accountId }) =>
        deleteAccountFromConfigSection({
          cfg,
          sectionKey: "linq",
          accountId,
          clearBaseFields: ["apiToken", "tokenFile", "fromPhone", "name"],
        }),
      isConfigured: (account) => Boolean(account.token?.trim()),
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: Boolean(account.token?.trim()),
        tokenSource: account.tokenSource,
        webhookSecretSource: account.webhookSecretSource,
        fromPhone: account.fromPhone,
      }),
      resolveAllowFrom: ({ cfg, accountId }) =>
        (resolveLinqAccountForStatus({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
          String(entry),
        ),
      formatAllowFrom: ({ allowFrom }) =>
        allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
    },
    security: {
      resolveDmPolicy: ({ cfg, accountId, account }) => {
        const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
        const linqSection = (cfg.channels as Record<string, unknown> | undefined)?.linq as
          | Record<string, unknown>
          | undefined;
        const useAccountPath = Boolean(
          (linqSection?.accounts as Record<string, unknown> | undefined)?.[resolvedAccountId],
        );
        const basePath = useAccountPath
          ? `channels.linq.accounts.${resolvedAccountId}.`
          : "channels.linq.";
        return {
          policy: account.config.dmPolicy ?? "open",
          allowFrom: account.config.allowFrom ?? [],
          policyPath: `${basePath}dmPolicy`,
          allowFromPath: basePath,
          approveHint: formatPairingApproveHint("linq"),
        };
      },
    },
    setup: {
      resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
      applyAccountName: ({ cfg, accountId, name }) =>
        applyAccountNameToChannelSection({
          cfg,
          channelKey: "linq",
          accountId,
          name,
        }),
      validateInput: ({ accountId, input }) => {
        if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
          return "LINQ_API_TOKEN can only be used for the default account.";
        }
        if (!input.useEnv && !input.token && !input.tokenFile) {
          return "Linq requires an API token or --token-file (or --use-env).";
        }
        return null;
      },
      applyAccountConfig: ({ cfg, accountId, input }) => {
        const namedConfig = applyAccountNameToChannelSection({
          cfg,
          channelKey: "linq",
          accountId,
          name: input.name,
        });
        const next =
          accountId !== DEFAULT_ACCOUNT_ID
            ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "linq" })
            : namedConfig;
        if (accountId === DEFAULT_ACCOUNT_ID) {
          return {
            ...next,
            channels: {
              ...next.channels,
              linq: {
                ...((next.channels as Record<string, unknown> | undefined)?.linq as
                  | Record<string, unknown>
                  | undefined),
                enabled: true,
                ...(input.useEnv
                  ? {}
                  : input.tokenFile
                    ? { tokenFile: input.tokenFile }
                    : input.token
                      ? { apiToken: input.token }
                      : {}),
              },
            },
          };
        }
        const linqSection = (next.channels as Record<string, unknown> | undefined)?.linq as
          | Record<string, unknown>
          | undefined;
        return {
          ...next,
          channels: {
            ...next.channels,
            linq: {
              ...linqSection,
              enabled: true,
              accounts: {
                ...(linqSection?.accounts as Record<string, unknown> | undefined),
                [accountId]: {
                  ...((linqSection?.accounts as Record<string, unknown> | undefined)?.[
                    accountId
                  ] as Record<string, unknown> | undefined),
                  enabled: true,
                  ...(input.tokenFile
                    ? { tokenFile: input.tokenFile }
                    : input.token
                      ? { apiToken: input.token }
                      : {}),
                },
              },
            },
          },
        };
      },
    },
    secrets: {
      secretTargetRegistryEntries: linqSecretTargetRegistryEntries,
      collectRuntimeConfigAssignments: collectLinqRuntimeConfigAssignments,
    },
  };
}
