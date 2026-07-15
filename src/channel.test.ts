import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import linqSetupEntry from "../setup-entry.js";
import { linqPlugin } from "./channel.js";
import { linqSetupPlugin } from "./channel.setup.js";

describe("Linq channel discovery", () => {
  it("exposes a runtime-free channel plugin to setup-only discovery", () => {
    expect(linqSetupEntry.plugin).toBe(linqSetupPlugin);
    expect(linqSetupEntry.plugin).not.toBe(linqPlugin);
    expect(linqSetupPlugin.setupWizard).toBe(linqPlugin.setupWizard);
    expect(linqSetupPlugin.setup).toBeDefined();
    expect(linqSetupPlugin.configSchema).toBe(linqPlugin.configSchema);
    expect(linqSetupPlugin).not.toHaveProperty("gateway");
    expect(linqSetupPlugin).not.toHaveProperty("outbound");
    expect(linqSetupPlugin).not.toHaveProperty("message");
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

    expect(packageJson.openclaw?.setupEntry).toBe("./setup-entry.ts");
    expect(packageJson.openclaw?.channel).toMatchObject({
      id: "linq",
      selectionLabel: "Linq (Messaging API)",
    });
  });
});
