import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { linqOnboardingAdapter } from "./onboarding.js";

const phone = "+15551112222";

function createPrompter(params: {
  ingressMode: "existing" | "tailscale" | "cloudflare" | "outbound-only";
  webhookPath?: string;
  webhookUrl?: string;
  confirm?: (message: string) => boolean;
}) {
  const notes: Array<{ message: string; title?: string }> = [];
  const textMessages: string[] = [];
  const prompter = {
    note: vi.fn(async (message: string, title?: string) => {
      notes.push({ message, title });
    }),
    confirm: vi.fn(async ({ message }: { message: string }) => params.confirm?.(message) ?? true),
    select: vi.fn(async ({ message }: { message: string }) => {
      return message === "Linq sender phone number" ? phone : params.ingressMode;
    }),
    text: vi.fn(async ({ message }: { message: string }) => {
      textMessages.push(message);
      if (message === "Local webhook path") {
        return params.webhookPath ?? "/linq-webhook";
      }
      if (message === "Public webhook URL") {
        return params.webhookUrl ?? "https://messages.example.com/linq-webhook";
      }
      throw new Error(`Unexpected text prompt: ${message}`);
    }),
  } as unknown as WizardPrompter;
  return { prompter, notes, textMessages };
}

function configuredAccount(overrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    gateway: { port: 19001 },
    channels: {
      linq: {
        enabled: true,
        apiToken: "test-token",
        fromPhone: phone,
        dmPolicy: "open",
        allowFrom: ["*"],
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

function stubPhoneProbeAndSubscriptionCreation() {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/phone_numbers")) {
      return new Response(JSON.stringify({ phone_numbers: [{ phone_number: phone }] }), {
        status: 200,
      });
    }
    if (url.endsWith("/webhook-subscriptions") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          id: "sub_ready",
          is_active: true,
          subscribed_events: ["message.received"],
          target_url: "https://messages.example.com/hooks/linq",
          phone_numbers: [phone],
          signing_secret: "signing-secret",
        }),
        { status: 201 },
      );
    }
    if (url.endsWith("/webhook-subscriptions")) {
      return new Response(JSON.stringify({ subscriptions: [] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Linq onboarding wizard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a ready, path-scoped inbound configuration", async () => {
    const fetchMock = stubPhoneProbeAndSubscriptionCreation();
    const { prompter, notes } = createPrompter({
      ingressMode: "cloudflare",
      webhookPath: "/hooks/linq",
      webhookUrl: "https://messages.example.com/hooks/linq",
    });

    const result = await linqOnboardingAdapter.configure({
      cfg: configuredAccount(),
      prompter,
      runtime: {} as never,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const linq = result.cfg.channels?.linq as Record<string, unknown>;

    expect(linq.webhookPath).toBe("/hooks/linq");
    expect(linq.webhookUrl).toBe("https://messages.example.com/hooks/linq");
    expect(linq.webhookSecret).toBe("signing-secret");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.linqapp.com/api/partner/v3/webhook-subscriptions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          subscribed_events: ["message.received"],
          target_url: "https://messages.example.com/hooks/linq",
          phone_numbers: [phone],
        }),
      }),
    );
    expect(notes.some((note) => note.message.includes("path: ^/hooks/linq$"))).toBe(true);
    expect(
      notes.some(
        (note) =>
          note.title === "Linq setup summary" &&
          note.message.includes("Local route: http://127.0.0.1:19001/hooks/linq") &&
          note.message.includes("Inbound readiness: READY"),
      ),
    ).toBe(true);
  });

  it("makes outbound-only explicit without storing a fake webhook URL", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/phone_numbers")) {
        return new Response(JSON.stringify({ phone_numbers: [{ phone_number: phone }] }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { prompter, notes, textMessages } = createPrompter({
      ingressMode: "outbound-only",
    });

    const result = await linqOnboardingAdapter.configure({
      cfg: configuredAccount(),
      prompter,
      runtime: {} as never,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const linq = result.cfg.channels?.linq as Record<string, unknown>;

    expect(linq.webhookPath).toBe("/linq-webhook");
    expect(linq).not.toHaveProperty("webhookUrl");
    expect(linq).not.toHaveProperty("webhookSecret");
    expect(textMessages).not.toContain("Public webhook URL");
    expect(notes.some((note) => note.message.includes("Inbound readiness: OUTBOUND ONLY"))).toBe(
      true,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stores named-account ingress under that account", async () => {
    stubPhoneProbeAndSubscriptionCreation();
    const { prompter } = createPrompter({
      ingressMode: "existing",
      webhookPath: "/hooks/linq",
      webhookUrl: "https://messages.example.com/hooks/linq",
    });
    const cfg = {
      gateway: { port: 19001 },
      channels: {
        linq: {
          enabled: true,
          accounts: {
            work: {
              enabled: true,
              apiToken: "test-token",
              fromPhone: phone,
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = await linqOnboardingAdapter.configure({
      cfg,
      prompter,
      runtime: {} as never,
      accountOverrides: { linq: "work" },
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const linq = result.cfg.channels?.linq as Record<string, any>;

    expect(linq).not.toHaveProperty("webhookUrl");
    expect(linq.accounts.work).toMatchObject({
      webhookPath: "/hooks/linq",
      webhookUrl: "https://messages.example.com/hooks/linq",
      webhookSecret: "signing-secret",
    });
  });

  it("preserves existing inbound config when outbound-only cleanup is declined", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/phone_numbers")) {
        return new Response(JSON.stringify({ phone_numbers: [{ phone_number: phone }] }), {
          status: 200,
        });
      }
      if (url.endsWith("/webhook-subscriptions")) {
        return new Response(
          JSON.stringify({
            subscriptions: [
              {
                id: "sub_shared",
                is_active: true,
                subscribed_events: ["message.received"],
                target_url: "https://messages.example.com/original",
                phone_numbers: null,
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { prompter, notes } = createPrompter({
      ingressMode: "outbound-only",
      webhookPath: "/changed-but-not-saved",
      confirm: (message) => !message.startsWith("Delete unfiltered Linq webhook subscription"),
    });

    const result = await linqOnboardingAdapter.configure({
      cfg: configuredAccount({
        webhookUrl: "https://messages.example.com/original",
        webhookPath: "/original",
        webhookSecret: "existing-secret",
      }),
      prompter,
      runtime: {} as never,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const linq = result.cfg.channels?.linq as Record<string, unknown>;

    expect(linq).toMatchObject({
      webhookUrl: "https://messages.example.com/original",
      webhookPath: "/original",
      webhookSecret: "existing-secret",
    });
    expect(prompter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("may receive messages for other lines"),
      }),
    );
    expect(
      notes.some(
        (note) =>
          note.title === "Linq setup summary" &&
          note.message.includes("Local route: http://127.0.0.1:19001/original") &&
          note.message.includes("EXISTING CONFIGURATION PRESERVED"),
      ),
    ).toBe(true);
  });

  it("clears a stale secret when a replacement subscription returns no secret", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/phone_numbers")) {
        return new Response(JSON.stringify({ phone_numbers: [{ phone_number: phone }] }), {
          status: 200,
        });
      }
      if (url.endsWith("/webhook-subscriptions/sub_old") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/webhook-subscriptions") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "sub_new",
            is_active: true,
            subscribed_events: ["message.received"],
            target_url: "https://new.example.com/linq-webhook",
            phone_numbers: [phone],
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/webhook-subscriptions")) {
        return new Response(
          JSON.stringify({
            subscriptions: [
              {
                id: "sub_old",
                is_active: true,
                subscribed_events: ["message.received"],
                target_url: "https://old.example.com/linq-webhook",
                phone_numbers: [phone],
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { prompter, notes } = createPrompter({
      ingressMode: "existing",
      webhookUrl: "https://new.example.com/linq-webhook",
    });

    const result = await linqOnboardingAdapter.configure({
      cfg: configuredAccount({
        webhookUrl: "https://old.example.com/linq-webhook",
        webhookPath: "/linq-webhook",
        webhookSecret: "old-secret",
      }),
      prompter,
      runtime: {} as never,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const linq = result.cfg.channels?.linq as Record<string, unknown>;

    expect(linq.webhookUrl).toBe("https://new.example.com/linq-webhook");
    expect(linq).not.toHaveProperty("webhookSecret");
    expect(
      notes.some(
        (note) =>
          note.title === "Linq setup summary" &&
          note.message.includes("Signing secret: missing") &&
          note.message.includes("Inbound readiness: INCOMPLETE"),
      ),
    ).toBe(true);
  });
});
