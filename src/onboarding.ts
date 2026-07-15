import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveGatewayPort } from "openclaw/plugin-sdk/core";
import type {
  ChannelSetupWizardAdapter as ChannelOnboardingAdapter,
  ChannelSetupDmPolicy as ChannelOnboardingDmPolicy,
  DmPolicy,
  WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  addWildcardAllowFrom,
  promptAccountId,
} from "openclaw/plugin-sdk/setup";
import {
  listLinqAccountIds,
  resolveDefaultLinqAccountId,
  resolveLinqAccount,
  resolveLinqAccountForStatus,
} from "./linq/accounts.js";
import { probeLinq } from "./linq/probe.js";
import { configureLinqWebhookOnboarding } from "./linq/onboarding-webhook.js";

const channel = "linq" as const;

function setLinqAccountPatch(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Record<string, unknown>,
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        linq: {
          ...cfg.channels?.linq,
          ...patch,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      linq: {
        ...cfg.channels?.linq,
        enabled: true,
        accounts: {
          ...cfg.channels?.linq?.accounts,
          [accountId]: {
            ...cfg.channels?.linq?.accounts?.[accountId],
            ...patch,
          },
        },
      },
    },
  };
}

function clearLinqAccountFields(
  cfg: OpenClawConfig,
  accountId: string,
  fields: readonly string[],
): OpenClawConfig {
  const clear = (value: unknown): Record<string, unknown> => {
    const next = { ...(value as Record<string, unknown> | undefined) };
    for (const field of fields) {
      delete next[field];
    }
    return next;
  };
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        linq: clear(cfg.channels?.linq),
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      linq: {
        ...cfg.channels?.linq,
        accounts: {
          ...cfg.channels?.linq?.accounts,
          [accountId]: clear(cfg.channels?.linq?.accounts?.[accountId]),
        },
      },
    },
  };
}

function setLinqDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.linq?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      linq: {
        ...cfg.channels?.linq,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

async function noteLinqTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Sign up at linqapp.com",
      "2) Copy your API token from the dashboard",
      "3) Tip: you can also set LINQ_API_TOKEN in your env.",
    ].join("\n"),
    "Linq API token",
  );
}

async function noteLinqPhoneHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Your Linq phone number is shown in your linqapp.com dashboard.",
      "This is the number people will text to reach your agent.",
    ].join("\n"),
    "Linq phone number",
  );
}

async function selectLinqPhone(params: {
  prompter: WizardPrompter;
  token: string;
  existingPhone?: string;
}): Promise<string> {
  const { prompter, token, existingPhone } = params;
  let phoneNumbers: string[] = [];
  try {
    const probe = await probeLinq(token, 5000);
    phoneNumbers = probe.ok ? (probe.phoneNumbers ?? []) : [];
    if (!probe.ok && probe.error) {
      await prompter.note(`Could not list Linq phone numbers: ${probe.error}`, "Linq phone lookup");
    }
  } catch (err) {
    await prompter.note(`Could not list Linq phone numbers: ${String(err)}`, "Linq phone lookup");
  }

  if (phoneNumbers.length > 0) {
    return String(
      await prompter.select({
        message: "Linq sender phone number",
        initialValue:
          existingPhone && phoneNumbers.includes(existingPhone) ? existingPhone : phoneNumbers[0],
        options: phoneNumbers.map((phone) => ({ value: phone, label: phone })),
      }),
    );
  }

  await noteLinqPhoneHelp(prompter);
  return String(
    await prompter.text({
      message: "Linq phone number (E.164 format, e.g. +15551234567)",
      initialValue: existingPhone,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Linq",
  channel,
  policyKey: "channels.linq.dmPolicy",
  allowFromKey: "channels.linq.allowFrom",
  getCurrent: (cfg) => cfg.channels?.linq?.dmPolicy ?? "open",
  setPolicy: (cfg, policy) => setLinqDmPolicy(cfg, policy),
};

export const linqOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listLinqAccountIds(cfg).some((accountId) =>
      Boolean(resolveLinqAccountForStatus({ cfg, accountId }).token),
    );
    return {
      channel,
      configured,
      statusLines: [`Linq: ${configured ? "configured" : "needs token"}`],
      selectionHint: configured
        ? "recommended · configured"
        : "recommended · iMessage blue bubbles",
      quickstartScore: configured ? 1 : 10,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const linqOverride = accountOverrides.linq?.trim();
    const defaultLinqAccountId = resolveDefaultLinqAccountId(cfg);
    let linqAccountId = linqOverride ? normalizeAccountId(linqOverride) : defaultLinqAccountId;
    if (shouldPromptAccountIds && !linqOverride) {
      linqAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "Linq",
        currentId: linqAccountId,
        listAccountIds: listLinqAccountIds,
        defaultAccountId: defaultLinqAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveLinqAccount({
      cfg: next,
      accountId: linqAccountId,
    });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = linqAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv = allowEnv && Boolean(process.env.LINQ_API_TOKEN?.trim());
    const hasConfigToken = Boolean(
      resolvedAccount.config.apiToken || resolvedAccount.config.tokenFile,
    );

    let token: string | null = null;
    if (!accountConfigured) {
      await noteLinqTokenHelp(prompter);
    }
    if (canUseEnv && !resolvedAccount.config.apiToken) {
      const keepEnv = await prompter.confirm({
        message: "LINQ_API_TOKEN detected. Use env var?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            linq: {
              ...next.channels?.linq,
              enabled: true,
            },
          },
        };
      } else {
        token = String(
          await prompter.text({
            message: "Enter Linq API token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigToken) {
      const keep = await prompter.confirm({
        message: "Linq token already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        token = String(
          await prompter.text({
            message: "Enter Linq API token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      token = String(
        await prompter.text({
          message: "Enter Linq API token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (token) {
      next = setLinqAccountPatch(next, linqAccountId, { enabled: true, apiToken: token });
    }

    // --- fromPhone ---
    const accountAfterToken = resolveLinqAccount({ cfg: next, accountId: linqAccountId });
    const previousFromPhone = accountAfterToken.fromPhone;
    const fromPhone = await selectLinqPhone({
      prompter,
      token: accountAfterToken.token,
      existingPhone: accountAfterToken.fromPhone,
    });

    next = setLinqAccountPatch(next, linqAccountId, { fromPhone });

    // --- Public webhook ingress ---
    const accountBeforeWebhook = resolveLinqAccount({ cfg: next, accountId: linqAccountId });
    const webhookResult = await configureLinqWebhookOnboarding({
      prompter,
      token: accountBeforeWebhook.token,
      fromPhone,
      previousFromPhone,
      existingWebhookUrl: accountBeforeWebhook.config.webhookUrl,
      existingWebhookPath: accountBeforeWebhook.config.webhookPath,
      hasWebhookSecret: Boolean(accountBeforeWebhook.webhookSecret),
      gatewayPort: resolveGatewayPort(next),
    });
    if (webhookResult.mode === "inbound") {
      next = setLinqAccountPatch(next, linqAccountId, {
        webhookUrl: webhookResult.webhookUrl,
        webhookPath: webhookResult.webhookPath,
        ...(webhookResult.signingSecret ? { webhookSecret: webhookResult.signingSecret } : {}),
      });
      if (webhookResult.clearSigningSecret) {
        next = clearLinqAccountFields(next, linqAccountId, ["webhookSecret"]);
      }
    } else if (webhookResult.mode === "outbound-only") {
      next = setLinqAccountPatch(next, linqAccountId, {
        webhookPath: webhookResult.webhookPath,
      });
      next = clearLinqAccountFields(next, linqAccountId, ["webhookUrl", "webhookSecret"]);
    }

    if (!next.channels?.linq?.dmPolicy) {
      next = setLinqDmPolicy(next, "open");
    }

    return { cfg: next, accountId: linqAccountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      linq: { ...cfg.channels?.linq, enabled: false },
    },
  }),
};
