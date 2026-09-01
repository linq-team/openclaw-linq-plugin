import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import linqSetupEntry from "../setup-entry.js";
import { linqPlugin } from "./channel.js";

describe("Linq channel discovery", () => {
  it("exposes the channel plugin to setup-only discovery", () => {
    expect(linqSetupEntry.plugin).toBe(linqPlugin);
  });

  it("declares the setup entry and channel catalog metadata", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      openclaw?: {
        setupEntry?: string;
        channel?: { id?: string; selectionLabel?: string };
      };
    };

    // dist/, not src/: `plugins install` refuses TypeScript-only packages, so
    // the shipped entry has to be the compiled bundle (see the ship-dist commit).
    expect(packageJson.openclaw?.setupEntry).toBe("./dist/setup-entry.js");
    expect(packageJson.openclaw?.channel).toMatchObject({
      id: "linq",
      selectionLabel: "Linq (Messaging API)",
    });
  });
});
