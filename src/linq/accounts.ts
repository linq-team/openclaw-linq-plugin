import { readFileSync } from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/core";
import type { LinqAccountConfig, LinqSecretRef } from "./types.js";

export type ResolvedLinqAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "config" | "env" | "file" | "secretRef" | "none";
  webhookSecret: string;
  webhookSecretSource: "config" | "file" | "env" | "secretRef" | "none";
  fromPhone?: string;
  config: LinqAccountConfig;
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels as Record<string, unknown> | undefined)?.linq as
    | LinqAccountConfig
    | undefined;
  if (!accounts?.accounts || typeof accounts.accounts !== "object") {
    return [];
  }
  return Object.keys(accounts.accounts).filter(Boolean);
}

export function listLinqAccountIds(cfg: OpenClawConfig): string[] {
  const linqSection = (cfg.channels as Record<string, unknown> | undefined)?.linq as
    | LinqAccountConfig
    | undefined;
  const ids = listConfiguredAccountIds(cfg);
  const defaultAccount = linqSection?.defaultAccount?.trim();
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  if (defaultAccount && !ids.includes(defaultAccount)) {
    ids.push(defaultAccount);
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultLinqAccountId(cfg: OpenClawConfig): string {
  const linqSection = (cfg.channels as Record<string, unknown> | undefined)?.linq as
    | LinqAccountConfig
    | undefined;
  const configured = linqSection?.defaultAccount?.trim();
  if (configured) {
    return normalizeAccountId(configured);
  }
  const ids = listLinqAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): LinqAccountConfig | undefined {
  const linqSection = (cfg.channels as Record<string, unknown> | undefined)?.linq as
    | LinqAccountConfig
    | undefined;
  if (!linqSection?.accounts || typeof linqSection.accounts !== "object") {
    return undefined;
  }
  return linqSection.accounts[accountId];
}

function mergeLinqAccountConfig(cfg: OpenClawConfig, accountId: string): LinqAccountConfig {
  const linqSection = (cfg.channels as Record<string, unknown> | undefined)?.linq as
    | (LinqAccountConfig & { accounts?: unknown })
    | undefined;
  const { accounts: _ignored, ...base } = linqSection ?? {};
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveToken(
  merged: LinqAccountConfig,
  accountId: string,
): { token: string; source: "config" | "env" | "file" | "secretRef" } | { token: ""; source: "none" } {
  const envToken = process.env.LINQ_API_TOKEN?.trim() ?? "";
  if (envToken && accountId === DEFAULT_ACCOUNT_ID) {
    return { token: envToken, source: "env" };
  }
  const refToken = resolveSecretRef(secretRefFromValue(merged.apiToken));
  if (refToken) {
    return { token: refToken.token, source: refToken.source };
  }
  if (typeof merged.apiToken === "string" && merged.apiToken.trim()) {
    return { token: merged.apiToken.trim(), source: "config" };
  }
  if (merged.tokenFile?.trim()) {
    try {
      const content = readFileSync(merged.tokenFile.trim(), "utf8").trim();
      if (content) {
        return { token: content, source: "file" };
      }
    } catch {
      // fall through
    }
  }
  return { token: "", source: "none" };
}

function secretRefFromValue(value: unknown): LinqSecretRef | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<LinqSecretRef>;
  if (
    (record.source === "env" || record.source === "file") &&
    typeof record.id === "string" &&
    record.id.trim()
  ) {
    return {
      source: record.source,
      provider: typeof record.provider === "string" ? record.provider : undefined,
      id: record.id,
    };
  }
  return undefined;
}

function resolveSecretRef(
  ref: LinqSecretRef | undefined,
): { token: string; source: "env" | "file" | "secretRef" } | null {
  if (!ref?.id?.trim()) {
    return null;
  }
  if (ref.source === "env") {
    const token = process.env[ref.id.trim()]?.trim() ?? "";
    return token ? { token, source: "env" } : null;
  }
  if (ref.source === "file") {
    try {
      const token = readFileSync(ref.id.trim(), "utf8").trim();
      return token ? { token, source: "file" } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function resolveWebhookSecret(
  merged: LinqAccountConfig,
): { secret: string; source: "config" | "env" | "file" | "secretRef" } | { secret: ""; source: "none" } {
  const refSecret = resolveSecretRef(secretRefFromValue(merged.webhookSecret));
  if (refSecret) {
    return { secret: refSecret.token, source: refSecret.source };
  }
  if (typeof merged.webhookSecret === "string" && merged.webhookSecret.trim()) {
    return { secret: merged.webhookSecret.trim(), source: "config" };
  }
  return { secret: "", source: "none" };
}

export function resolveLinqAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedLinqAccount {
  const accountId = normalizeAccountId(params.accountId);
  const linqSection = (params.cfg.channels as Record<string, unknown> | undefined)?.linq as
    | LinqAccountConfig
    | undefined;
  const baseEnabled = linqSection?.enabled !== false;
  const merged = mergeLinqAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const { token, source } = resolveToken(merged, accountId);
  const webhookSecret = resolveWebhookSecret(merged);
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: merged.name?.trim() || undefined,
    token,
    tokenSource: source,
    webhookSecret: webhookSecret.secret,
    webhookSecretSource: webhookSecret.source,
    fromPhone: merged.fromPhone?.trim() || undefined,
    config: merged,
  };
}
