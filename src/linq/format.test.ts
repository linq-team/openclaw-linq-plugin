import { describe, expect, it } from "vitest";
import { toPlainText } from "./format.js";

describe("toPlainText", () => {
  it("drops emphasis markers instead of sending them to the handset", () => {
    expect(toPlainText("**Revenue** grew *fast*")).toBe("Revenue grew fast");
  });

  it("flattens headings and list markers", () => {
    const out = toPlainText("## Summary\n\n- one\n- two");
    expect(out).not.toMatch(/^##/m);
    expect(out).toContain("Summary");
    expect(out).toContain("one");
    expect(out).toContain("two");
  });

  it("keeps a link's destination, which stripping markup would lose", () => {
    expect(toPlainText("see [the memo](https://example.com/m)")).toBe(
      "see the memo (https://example.com/m)",
    );
  });

  it("does not repeat a bare URL as its own label", () => {
    expect(toPlainText("<https://example.com>")).toBe("https://example.com");
  });

  it("leaves arithmetic alone — the reason this is not a regex", () => {
    // A regex stripper reads the asterisks here as emphasis and eats them.
    expect(toPlainText("2 * 3 * 4 = 24")).toBe("2 * 3 * 4 = 24");
  });

  it("keeps code contents, only losing the fence", () => {
    const out = toPlainText("run this:\n\n```\nnpm test\n```");
    expect(out).toContain("npm test");
    expect(out).not.toContain("```");
  });

  it("renders a table as lines rather than a pipe grid", () => {
    const out = toPlainText("| Deal | IRR |\n| --- | --- |\n| Acme | 22% |");
    expect(out).not.toContain("---");
    expect(out).toContain("Acme");
    expect(out).toContain("22%");
  });

  it("collapses the blank runs that removing block markup leaves behind", () => {
    expect(toPlainText("# A\n\n\n\n## B")).toBe("A\n\nB");
  });

  it("passes plain text through untouched", () => {
    expect(toPlainText("just a sentence")).toBe("just a sentence");
  });

  it("returns empty input unchanged rather than throwing", () => {
    expect(toPlainText("")).toBe("");
    expect(toPlainText("   ")).toBe("   ");
  });
});
