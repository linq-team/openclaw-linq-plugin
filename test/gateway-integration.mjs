// Synthetic end-to-end fixture: real Gateway, agent/model pipeline and channel delivery.
// No Linq account, public tunnel or handset is involved.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const home = await mkdtemp(path.join(tmpdir(), "linq-gateway-proof-"));
const secret = randomBytes(32);
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let modelCalls = 0;
let modelImages = 0;
const sends = [];
const fixture = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  if (req.url === "/v1/chat/completions") {
    modelCalls++;
    assert(JSON.stringify(body.messages).includes("LINQ_GATEWAY_FIXTURE_TEXT"));
    for (const message of body.messages ?? []) {
      if (Array.isArray(message.content)) {
        modelImages += message.content.filter(
          (part) =>
            part.type === "image_url" &&
            part.image_url?.url?.startsWith("data:image/"),
        ).length;
      }
    }
    const content = "[Linq fixture] Automatic reply through the real Gateway.";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [delta, finish_reason] of [
      [{ role: "assistant", content }, null],
      [{}, "stop"],
    ]) {
      res.write(
        "data: " +
          JSON.stringify({
            id: "fixture-completion",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n",
      );
    }
    res.end("data: [DONE]\n\n");
  } else if (req.url === "/api/partner/v3/phone_numbers") {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ phone_numbers: [{ phone_number: "+15555550101" }] }),
    );
  } else if (req.url === "/api/partner/v3/chats/fixture-chat/messages") {
    sends.push(body);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        message: { id: "fixture-reply-" + sends.length },
        chat_id: "fixture-chat",
      }),
    );
  } else {
    res.writeHead(404).end();
  }
});
await listen(fixture);
const base = "http://127.0.0.1:" + fixture.address().port;
const reservation = createServer();
await listen(reservation);
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
await mkdir(path.join(home, "workspace"));
const preload = path.join(home, "provider-fixture.mjs");
await writeFile(
  preload,
  `const original = globalThis.fetch; globalThis.fetch = (input, init) => { const url = String(input); if (url === 'https://example.com/linq-fixture.png') return Promise.resolve(new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'), {headers: {'content-type': 'image/png'}})); return original(url.startsWith('https://api.linqapp.com/') ? ${JSON.stringify(base)} + new URL(url).pathname : input, init); }; globalThis.fetch.mock = {};`,
);
const config = {
  gateway: {
    mode: "local",
    bind: "loopback",
    port,
    auth: { mode: "token", token: randomBytes(24).toString("hex") },
    controlUi: { enabled: false },
  },
  logging: {
    level: "warn",
    consoleLevel: "warn",
    file: path.join(home, "gateway.log"),
  },
  plugins: {
    allow: ["linq"],
    load: { paths: [process.env.LINQ_PACKAGE_ROOT ?? root] },
    entries: { linq: { enabled: true } },
  },
  channels: {
    linq: {
      apiToken: "fixture-not-a-credential",
      fromPhone: "+15555550101",
      webhookSecret: "whsec_" + secret.toString("base64"),
      webhookPath: "/linq-proof",
      dmPolicy: "allowlist",
      allowFrom: ["+15555550102"],
    },
  },
  agents: {
    defaults: {
      workspace: path.join(home, "workspace"),
      skipBootstrap: true,
      model: { primary: "linq-fixture/fixture" },
      heartbeat: { every: "0m" },
    },
  },
  models: {
    providers: {
      "linq-fixture": {
        baseUrl: base + "/v1",
        apiKey: "fixture",
        api: "openai-completions",
        models: [
          {
            id: "fixture",
            name: "Deterministic channel fixture",
            input: ["text", "image"],
            reasoning: false,
            contextWindow: 32000,
            maxTokens: 1024,
          },
        ],
      },
    },
  },
};
const configPath = path.join(home, "openclaw.json");
await writeFile(configPath, JSON.stringify(config));
const gateway = spawn(
  process.execPath,
  [
    "--import",
    preload,
    path.join(root, "node_modules/openclaw/openclaw.mjs"),
    "gateway",
    "run",
  ],
  {
    cwd: home,
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(home, "state"),
      OPENCLAW_CONFIG_PATH: configPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
gateway.stdout.on("data", (data) => {
  output += data;
});
gateway.stderr.on("data", (data) => {
  output += data;
});
const url = "http://127.0.0.1:" + port + "/linq-proof";
async function post(id, sender = "+15555550102", signed = true, media = false) {
  const body = JSON.stringify({
    webhook_version: "2026-02-03",
    event_id: id,
    event_type: "message.received",
    data: {
      id,
      chat: {
        id: "fixture-chat",
        is_group: false,
        owner_handle: { handle: "+15555550101" },
      },
      sender_handle: { handle: sender },
      parts: [
        { type: "text", value: "LINQ_GATEWAY_FIXTURE_TEXT" },
        ...(media
          ? [
              {
                type: "media",
                url: "https://example.com/linq-fixture.png",
                mime_type: "image/png",
              },
            ]
          : []),
      ],
      direction: "inbound",
      service: "SMS",
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(id + "." + timestamp + "." + body)
    .digest("base64");
  const response = await fetch(url, {
    method: "POST",
    body,
    headers: signed
      ? {
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": "v1," + signature,
        }
      : {},
  });
  await response.text();
  return response.status;
}
let passed = false;
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (gateway.exitCode !== null) throw new Error("Gateway exited: " + output);
    try {
      if ((await fetch(url)).status === 405) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(250);
  }
  assert(ready, "Gateway webhook did not start: " + output);
  assert.equal(await post("unsigned", undefined, false), 401);
  assert.equal(await post("allowed"), 200);
  for (let i = 0; i < 120 && !sends.length; i++) await sleep(250);
  assert.equal(sends.length, 1, "automatic reply missing: " + output);
  assert.equal(modelCalls, 1);
  assert(sends[0].message.parts[0].value.includes("[Linq fixture]"));
  assert(sends[0].message.idempotency_key);
  assert.equal(await post("allowed"), 200);
  assert.equal(await post("denied", "+15555550999"), 200);
  await sleep(2000);
  assert.equal(modelCalls, 1, "replayed/unauthorized message reached model");
  assert.equal(sends.length, 1, "replayed/unauthorized message caused send");
  assert.equal(await post("photo", undefined, true, true), 200);
  for (let i = 0; i < 120 && sends.length < 2; i++) await sleep(250);
  assert.equal(sends.length, 2, "media reply missing: " + output);
  assert(modelImages > 0, "model must receive usable image bytes");
  passed = true;
  console.log(
    "PASS real Gateway lifecycle, signed HTTP ingress, agent/model text and image bytes, automatic durable replies, replay and sender denial (synthetic provider/model)",
  );
} finally {
  gateway.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => gateway.once("exit", resolve)),
    sleep(5000),
  ]);
  if (gateway.exitCode === null) gateway.kill("SIGKILL");
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  if (passed) await rm(home, { recursive: true, force: true });
}
