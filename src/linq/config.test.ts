import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LinqChannelConfigSchema, LinqConfigSchema } from "./config.js";
import { resolveLinqAccount, resolveLinqAccountForStatus } from "./accounts.js";

describe("LinqConfigSchema", () => {
  it("accepts supported SecretRef-backed credentials and applies open dmPolicy by default", () => {
    const parsed = LinqConfigSchema.safeParse({
      apiToken: { source: "env", id: "LINQ_API_TOKEN" },
      webhookSecret: { source: "exec", provider: "vault", id: "linq/webhook-secret" },
      fromPhone: "+15556667777",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.dmPolicy).toBe("open");
  });

  it("rejects unsupported SecretRef sources and extra config knobs", () => {
    expect(
      LinqConfigSchema.safeParse({
        apiToken: { source: "literal", id: "op read token" },
      }).success,
    ).toBe(false);
    const invalid = LinqConfigSchema.safeParse({
      apiToken: "token",
      webhookMaxBytes: 2048,
    });
    expect(invalid.success).toBe(false);
  });

  it("exposes matching public JSON-schema and runtime validation", () => {
    expect(LinqChannelConfigSchema.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        accounts: {
          additionalProperties: { $ref: "#" },
        },
      },
    });
    expect(
      LinqChannelConfigSchema.runtime?.safeParse({
        apiToken: "token",
        fromPhone: "+15556667777",
      }),
    ).toMatchObject({ success: true, data: { dmPolicy: "open" } });
    expect(
      LinqChannelConfigSchema.runtime?.safeParse({
        apiToken: "token",
        webhookMaxBytes: 2048,
      }),
    ).toMatchObject({ success: false });
    expect(
      LinqChannelConfigSchema.runtime?.safeParse({
        accounts: { sales: { apiToken: "token", webhookMaxBytes: 2048 } },
      }),
    ).toMatchObject({ success: false });
  });

  it("keeps manifest channel schemas strict for nested accounts", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      configSchema: { properties: { accounts: unknown } };
      channelConfigs: { linq: { schema: { properties: { accounts: unknown } } } };
    };

    expect(manifest.configSchema.properties.accounts).toEqual({
      type: "object",
      additionalProperties: { $ref: "#" },
    });
    expect(manifest.channelConfigs.linq.schema.properties.accounts).toEqual({
      type: "object",
      additionalProperties: { $ref: "#" },
    });
  });
});

describe("resolveLinqAccount", () => {
  afterEach(() => {
    delete process.env.LINQ_TOKEN_TEST;
    delete process.env.LINQ_WEBHOOK_SECRET_TEST;
  });

  it("resolves env SecretRefs for account and webhook credentials", () => {
    process.env.LINQ_TOKEN_TEST = "resolved-token";
    process.env.LINQ_WEBHOOK_SECRET_TEST = "resolved-secret";

    const account = resolveLinqAccount({
      cfg: {
        channels: {
          linq: {
            accounts: {
              sales: {
                apiToken: { source: "env", id: "LINQ_TOKEN_TEST" },
                webhookSecret: { source: "env", id: "LINQ_WEBHOOK_SECRET_TEST" },
                fromPhone: "+15556667777",
              },
            },
          },
        },
      } as never,
      accountId: "sales",
    });

    expect(account).toMatchObject({
      accountId: "sales",
      token: "resolved-token",
      tokenSource: "env",
      webhookSecret: "resolved-secret",
      webhookSecretSource: "env",
      fromPhone: "+15556667777",
    });
  });

  it("throws on unresolved exec SecretRefs instead of treating them as missing", () => {
    expect(() =>
      resolveLinqAccount({
        cfg: {
          channels: {
            linq: {
              apiToken: { source: "exec", provider: "vault", id: "linq/token" },
            },
          },
        } as never,
      }),
    ).toThrow('channels.linq.apiToken: unresolved SecretRef "exec:vault:linq/token"');
  });

  it("keeps status resolution readable when SecretRefs are unresolved", () => {
    const account = resolveLinqAccountForStatus({
      cfg: {
        channels: {
          linq: {
            apiToken: { source: "env", id: "LINQ_TOKEN_TEST" },
            webhookSecret: { source: "env", id: "LINQ_WEBHOOK_SECRET_TEST" },
            fromPhone: "+15556667777",
          },
        },
      } as never,
    });

    expect(account).toMatchObject({
      token: "",
      tokenSource: "none",
      webhookSecret: "",
      webhookSecretSource: "none",
      fromPhone: "+15556667777",
    });
  });
});
