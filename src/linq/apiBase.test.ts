import { afterEach, describe, expect, it } from "vitest";
import { apiBaseFromConfig, linqApiBase, setLinqApiBase } from "./apiBase.js";

describe("linq api base", () => {
  afterEach(() => {
    setLinqApiBase(undefined);
    delete process.env.LINQ_API_BASE;
  });

  it("defaults to Linq's own cloud", () => {
    expect(linqApiBase()).toBe("https://api.linqapp.com/api/partner/v3");
  });

  it("takes config over env, and env over the default", () => {
    process.env.LINQ_API_BASE = "https://from-env.test/api/partner/v3";
    expect(linqApiBase()).toBe("https://from-env.test/api/partner/v3");

    // Config wins: it is the one that can arrive when the channel is connected,
    // whereas env is fixed when the container is created.
    setLinqApiBase("https://relay.test/api/partner/v3");
    expect(linqApiBase()).toBe("https://relay.test/api/partner/v3");
  });

  it("ignores a blank value instead of pointing at nothing", () => {
    setLinqApiBase("   ");
    expect(linqApiBase()).toBe("https://api.linqapp.com/api/partner/v3");
  });

  it("strips trailing slashes so paths do not double up", () => {
    setLinqApiBase("https://relay.test/api/partner/v3///");
    expect(linqApiBase()).toBe("https://relay.test/api/partner/v3");
  });

  it("reads channels.linq.apiBase, and survives a malformed config", () => {
    expect(apiBaseFromConfig({ channels: { linq: { apiBase: "https://r.test" } } }))
      .toBe("https://r.test");
    // Startup path: a bad config must not throw and take the channel down.
    expect(apiBaseFromConfig(undefined)).toBeUndefined();
    expect(apiBaseFromConfig({})).toBeUndefined();
    expect(apiBaseFromConfig({ channels: { linq: { apiBase: 42 } } })).toBeUndefined();
  });
});

describe("apiBase is accepted by the config schema", () => {
  it("validates, because the schema is strict", async () => {
    // The schema is `.strict()` / additionalProperties:false, so an undeclared
    // key is a hard validation failure, not an ignored extra. Writing apiBase
    // into a cell running a plugin build without it would break the channel
    // outright — hence declaring it in BOTH schemas, and pinning that here.
    const { LinqConfigSchema, LinqConfigJsonSchema } = await import("./config.js");
    const parsed = LinqConfigSchema.safeParse({
      apiToken: "tok",
      apiBase: "https://relay.test/api/partner/v3",
    });
    expect(parsed.success).toBe(true);
    expect(LinqConfigJsonSchema.properties).toHaveProperty("apiBase");
  });

  it("still rejects a genuinely unknown key", async () => {
    // Guards against someone "fixing" a future rejection by loosening strict,
    // which would silently accept typo'd config instead of reporting it.
    const { LinqConfigSchema } = await import("./config.js");
    expect(LinqConfigSchema.safeParse({ apiToken: "tok", apiBse: "x" }).success)
      .toBe(false);
  });
});
