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
