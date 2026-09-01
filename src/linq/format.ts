import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  convertMarkdownTables,
  markdownToIR,
  renderMarkdownWithMarkers,
} from "openclaw/plugin-sdk/text-chunking";
// The mode type lives with the table runtime, not the chunking surface.
import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";

/**
 * Render an agent reply for a channel with no markup at all.
 *
 * iMessage shows exactly the characters it is given. There is no bold, no
 * monospace, no link syntax — so an unrendered reply arrives as its own source:
 * "**Revenue** grew" with the asterisks showing, "## Summary" with the hashes,
 * and a table as a wall of pipes. On a channel whose whole point is that it
 * feels like a person on the other end, that reads as broken.
 *
 * This is the pipeline the built-in channels use — parse once to Markdown IR,
 * then render through a style map describing what the target supports — not a
 * regex over the raw text. The difference matters: the IR knows what is a code
 * fence and what is a link, so `2 * 3 * 4` keeps its asterisks and a link keeps
 * its destination. Telegram maps bold to <b>; here every style maps to nothing.
 */
const PLAIN_STYLES = {};

// A pipe grid is unreadable on a phone, so tables become bullet lines. The
// deployment can still override it through the normal `markdown.tableMode`
// setting; this is only the default for a channel that cannot draw a table.
const DEFAULT_TABLE_MODE: MarkdownTableMode = "bullets";

function tableMode(cfg?: OpenClawConfig): MarkdownTableMode {
  const configured = (cfg as { markdown?: { tableMode?: unknown } } | undefined)?.markdown
    ?.tableMode;
  return typeof configured === "string" && configured
    ? (configured as MarkdownTableMode)
    : DEFAULT_TABLE_MODE;
}

export function toPlainText(markdown: string, cfg?: OpenClawConfig): string {
  const source = markdown ?? "";
  if (!source.trim()) return source;

  try {
    const ir = markdownToIR(convertMarkdownTables(source, tableMode(cfg)));
    const rendered = renderMarkdownWithMarkers(ir, {
      styleMarkers: PLAIN_STYLES,
      // Nothing downstream re-interprets this text, so escaping would only add
      // backslashes for a human to read past.
      escapeText: (text) => text,
      // Dropping the markup must not drop the destination. A bare URL is
      // already its own label, so only append the href when it differs.
      buildLink: (link, text) => {
        const href = link.href?.trim();
        if (!href || href === text.trim()) return null;
        return { start: link.start, end: link.end, open: "", close: ` (${href})` };
      },
    });
    // Removing headings and list markers can leave three blank lines where the
    // source had one.
    return rendered.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    // A reply that renders imperfectly is a nuisance; a reply that never
    // arrives because formatting threw is a silent failure on a channel with no
    // other feedback path. Send the source rather than nothing.
    return source;
  }
}
