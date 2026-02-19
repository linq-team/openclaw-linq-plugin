import type { LinqSendResult } from "./types.js";
import { resolveLinqAccount, type ResolvedLinqAccount } from "./accounts.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

const LINQ_API_BASE = "https://api.linqapp.com/api/partner/v3";
const UA = "OpenClaw-Linq/1.0";
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = MAX_RETRIES,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status === 429 && attempt < retries) {
      const retryAfter = Number(response.headers.get("retry-after")) || 0;
      const delay = retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAY_MS * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(delay, 10_000)));
      continue;
    }
    return response;
  }
}

export type LinqSendOpts = {
  accountId?: string;
  mediaUrl?: string;
  replyToMessageId?: string;
  verbose?: boolean;
  token?: string;
  config?: OpenClawConfig;
  account?: ResolvedLinqAccount;
};

export async function sendMessageLinq(
  to: string,
  text: string,
  opts: LinqSendOpts = {},
): Promise<LinqSendResult> {
  const account = opts.account ?? (opts.config ? resolveLinqAccount({ cfg: opts.config, accountId: opts.accountId }) : undefined);
  const token = opts.token?.trim() || account?.token;
  if (!token) {
    throw new Error("Linq API token not configured");
  }

  const parts: Array<Record<string, unknown>> = [];
  if (text) {
    parts.push({ type: "text", value: text });
  }
  if (opts.mediaUrl?.trim()) {
    parts.push({ type: "media", url: opts.mediaUrl.trim() });
  }
  if (parts.length === 0) {
    throw new Error("Linq send requires text or media");
  }

  const message: Record<string, unknown> = { parts };
  if (opts.replyToMessageId?.trim()) {
    message.reply_to = { message_id: opts.replyToMessageId.trim() };
  }

  const url = `${LINQ_API_BASE}/chats/${encodeURIComponent(to)}/messages`;
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Linq API error: ${response.status} ${errorText.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    chat_id?: string;
    message?: { id?: string };
  };
  return {
    messageId: data.message?.id ?? "unknown",
    chatId: data.chat_id ?? to,
  };
}

/**
 * Fire-and-forget helper for side-effect API calls (typing, read receipts, reactions).
 * Swallows errors so callers don't need `.catch(() => {})` everywhere.
 */
async function fireAndForget(url: string, init: RequestInit): Promise<boolean> {
  try {
    const res = await fetch(url, init);
    return res.ok;
  } catch {
    return false;
  }
}

export async function startTypingLinq(chatId: string, token: string): Promise<boolean> {
  return fireAndForget(`${LINQ_API_BASE}/chats/${encodeURIComponent(chatId)}/typing`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
}

export async function stopTypingLinq(chatId: string, token: string): Promise<boolean> {
  return fireAndForget(`${LINQ_API_BASE}/chats/${encodeURIComponent(chatId)}/typing`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
}

export async function markAsReadLinq(chatId: string, token: string): Promise<boolean> {
  return fireAndForget(`${LINQ_API_BASE}/chats/${encodeURIComponent(chatId)}/read`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
}

export async function sendReactionLinq(
  messageId: string,
  type: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question",
  token: string,
  operation: "add" | "remove" = "add",
): Promise<boolean> {
  return fireAndForget(`${LINQ_API_BASE}/messages/${encodeURIComponent(messageId)}/reactions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({ operation, type }),
  });
}
