import { afterEach, describe, expect, it, vi } from "vitest";
import { probeLinq } from "./probe.js";

describe("probeLinq", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists Linq phone numbers from the documented v3 endpoint", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          phone_numbers: [{ phone_number: "+15551112222" }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeLinq("token", 1000)).resolves.toEqual({
      ok: true,
      phoneNumbers: ["+15551112222"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.linqapp.com/api/partner/v3/phone_numbers",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
  });
});
