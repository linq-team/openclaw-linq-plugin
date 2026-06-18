import { afterEach, describe, expect, it } from "vitest";
import { LinqConfigSchema } from "./config.js";
import { resolveLinqAccount } from "./accounts.js";

describe("LinqConfigSchema", () => {
  it("accepts supported SecretRef-backed credentials and applies open dmPolicy by default", () => {
    const parsed = LinqConfigSchema.safeParse({
      apiToken: { source: "env", id: "LINQ_API_TOKEN" },
      webhookSecret: { source: "file", id: "/tmp/linq-webhook-secret" },
      fromPhone: "+15556667777",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.dmPolicy).toBe("open");
  });

  it("rejects unsupported SecretRef sources and extra config knobs", () => {
    expect(
      LinqConfigSchema.safeParse({
        apiToken: { source: "exec", id: "op read token" },
      }).success,
    ).toBe(false);
    const invalid = LinqConfigSchema.safeParse({
      apiToken: "token",
      webhookMaxBytes: 2048,
    });
    expect(invalid.success).toBe(false);
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
});
