import { describe, expect, it } from "vitest";
import { normalizeLinqMessageReceivedData } from "./monitor.js";

describe("normalizeLinqMessageReceivedData", () => {
  it("keeps the legacy 2025 message.received shape", () => {
    const data = {
      chat_id: "chat_1",
      from: "+12025550100",
      recipient_phone: "+12025550101",
      received_at: "2026-02-05T19:31:13.736Z",
      is_from_me: false,
      service: "SMS",
      message: {
        id: "msg_1",
        parts: [{ type: "text", value: "hello" }],
      },
    };

    expect(normalizeLinqMessageReceivedData(data)).toEqual(data);
  });

  it("normalizes the current 2026 message.received shape", () => {
    expect(
      normalizeLinqMessageReceivedData({
        chat: {
          id: "chat_2",
          owner_handle: { handle: "+12025550101" },
        },
        id: "msg_2",
        direction: "inbound",
        sender_handle: { handle: "+12025550100", is_me: false },
        parts: [{ type: "text", value: "hello" }],
        sent_at: "2026-02-05T19:31:13.074Z",
        service: "SMS",
      }),
    ).toEqual({
      chat_id: "chat_2",
      from: "+12025550100",
      recipient_phone: "+12025550101",
      received_at: "2026-02-05T19:31:13.074Z",
      is_from_me: false,
      service: "SMS",
      message: {
        id: "msg_2",
        parts: [{ type: "text", value: "hello" }],
      },
    });
  });
});
