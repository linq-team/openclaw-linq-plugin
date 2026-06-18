import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { linqPlugin } from "./src/channel.js";
import { setLinqRuntime } from "./src/runtime.js";

const plugin = {
  id: "linq",
  name: "Linq",
  description: "Linq iMessage channel plugin — real iMessage over API, no Mac required",
  configSchema: linqPlugin.configSchema,
  register(api: OpenClawPluginApi) {
    setLinqRuntime(api.runtime);
    api.registerChannel({ plugin: linqPlugin as ChannelPlugin });
  },
};

export default plugin;
