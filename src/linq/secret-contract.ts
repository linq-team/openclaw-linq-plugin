import { hasOwnProperty } from "openclaw/plugin-sdk/channel-secret-runtime";
import {
  collectConditionalChannelFieldAssignments,
  getChannelSurface,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

const secretFields = ["apiToken", "webhookSecret"] as const;

export const linqSecretTargetRegistryEntries: SecretTargetRegistryEntry[] = secretFields.flatMap(
  (field) => [
    {
      id: `channels.linq.accounts.*.${field}`,
      targetType: `channels.linq.accounts.*.${field}`,
      configFile: "openclaw.json",
      pathPattern: `channels.linq.accounts.*.${field}`,
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
    },
    {
      id: `channels.linq.${field}`,
      targetType: `channels.linq.${field}`,
      configFile: "openclaw.json",
      pathPattern: `channels.linq.${field}`,
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
    },
  ],
);

export function collectLinqRuntimeConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}) {
  const resolved = getChannelSurface(params.config, "linq");
  if (!resolved) {
    return;
  }
  const { channel: linq, surface } = resolved;
  for (const field of secretFields) {
    collectConditionalChannelFieldAssignments({
      channelKey: "linq",
      field,
      channel: linq,
      surface,
      defaults: params.defaults,
      context: params.context,
      topLevelActiveWithoutAccounts: true,
      topLevelInheritedAccountActive: ({ account, enabled }) =>
        enabled && !hasOwnProperty(account, field),
      accountActive: ({ enabled }) => enabled,
      topInactiveReason: `no enabled Linq surface inherits this top-level ${field}.`,
      accountInactiveReason: "Linq account is disabled.",
    });
  }
}
