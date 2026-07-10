import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { linqPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(linqPlugin);
