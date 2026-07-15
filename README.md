# openclaw-linq-plugin

Linq iMessage channel plugin for [OpenClaw](https://github.com/openclaw/openclaw). Send and receive real iMessage (blue bubbles) through the [Linq API](https://linqapp.com) — no Mac required.

## Installation

```bash
openclaw plugins install github:linq-team/openclaw-linq-plugin
```

## Setup

Run the interactive setup wizard:

```bash
openclaw configure --section channels
```

Select **Linq (Messaging API)** from the channel list.

The wizard will walk you through:

1. **API token** — sign up at [linqapp.com](https://linqapp.com) and copy your token from the dashboard
2. **Phone number** — the Linq phone number shown in your dashboard (E.164 format, e.g. `+15551234567`)
3. **Local webhook path** — the dedicated path served by the OpenClaw Gateway (defaults to `/linq-webhook`)
4. **Inbound delivery** — an existing public HTTPS URL, a path-scoped Tailscale Funnel, a Cloudflare Tunnel/reverse proxy, or explicit outbound-only mode
5. **Readiness summary** — local route, public target, subscription, phone filter, signing-secret state, and the next verification action

Prefer a SecretRef for credentials. `LINQ_API_TOKEN` is still supported as a default-account setup convenience.

## Usage

Start the gateway:

```bash
openclaw gateway run
```

Your agent will receive iMessages via webhook and respond through the Linq API.

## Configuration

After running the wizard, your `openclaw.json` will contain:

```json
{
  "channels": {
    "linq": {
      "enabled": true,
      "apiToken": { "source": "env", "id": "LINQ_API_TOKEN" },
      "fromPhone": "+15551234567",
      "dmPolicy": "open",
      "webhookUrl": "https://messages.example.com/linq-webhook",
      "webhookPath": "/linq-webhook"
    }
  }
}
```

`webhookUrl` is the stable public HTTPS target registered with Linq. `webhookPath` is the matching route on the local OpenClaw Gateway. Outbound-only configurations omit `webhookUrl` and `webhookSecret`.

### Public ingress

The webhook route is served by the OpenClaw Gateway on `gateway.port` (default `18789`). Publish only the configured `webhookPath`; do not expose the Gateway root or Control UI. Linq requires a stable public HTTPS URL before the wizard will offer to create a subscription.

Start the Gateway before testing ingress:

```bash
openclaw gateway run
```

#### Tailscale Funnel

For a Gateway on port `18789`, publish only the Linq path:

```bash
tailscale funnel --bg --https=443 --set-path=/linq-webhook http://127.0.0.1:18789/linq-webhook
```

Enter the HTTPS hostname printed by Tailscale with `/linq-webhook` appended. The wizard detects the `tailscale` binary but never installs it or runs Funnel for you. Remove the route with:

```bash
tailscale funnel --https=443 --set-path=/linq-webhook off
```

See the [Tailscale Funnel CLI reference](https://tailscale.com/docs/reference/tailscale-cli/funnel) for installation and account requirements.

#### Cloudflare Tunnel

Use a named tunnel with a path matcher and a catch-all `404`; a quick tunnel pointed at the Gateway would expose more than the webhook route.

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: <CREDENTIALS-FILE>

ingress:
  - hostname: messages.example.com
    path: ^/linq-webhook$
    service: http://127.0.0.1:18789
  - service: http_status:404
```

Validate and run the configuration yourself:

```bash
cloudflared tunnel --config <CONFIG-PATH> ingress validate
cloudflared tunnel --config <CONFIG-PATH> run <TUNNEL-NAME>
```

Stop the foreground process with `Ctrl-C`. If the tunnel was dedicated to a temporary Linq setup, remove it after stopping it and remove its DNS record:

```bash
cloudflared tunnel delete <TUNNEL-NAME>
```

See Cloudflare's [configuration-file reference](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/) for tunnel creation, credentials, DNS routing, and service installation.

Other reverse proxies are supported when the public HTTPS path maps exactly to `http://127.0.0.1:<gateway.port><webhookPath>` and all unrelated paths are rejected.

### Multi-account

Multiple Linq accounts are supported via the `accounts` field:

```json
{
  "channels": {
    "linq": {
      "enabled": true,
      "accounts": {
        "sales": {
          "enabled": true,
          "apiToken": { "source": "env", "id": "LINQ_SALES_TOKEN" },
          "fromPhone": "+15551111111"
        },
        "support": {
          "enabled": true,
          "apiToken": { "source": "env", "id": "LINQ_SUPPORT_TOKEN" },
          "fromPhone": "+15552222222"
        }
      }
    }
  }
}
```

### DM policy

Control who can message your agent:

- `"open"` (default in this version) — anyone can message
- `"pairing"` — new senders must complete the OpenClaw pairing flow
- `"disabled"` — no inbound DMs

### Webhook security

Set a `webhookSecret` to enable HMAC signature verification on inbound webhooks:

```json
{
  "channels": {
    "linq": {
      "webhookSecret": { "source": "env", "id": "LINQ_WEBHOOK_SECRET" }
    }
  }
}
```

### Targets

Outbound targets use explicit Linq target grammar:

- `linq:+15556667777` for first contact by phone number
- `linq:chat:<chat_id>` for an existing direct chat
- `linq:<accountId>:+15556667777` for an account-scoped phone send

Group targets are reserved but disabled in this version.

## Features

- Real iMessage blue bubbles via Linq API
- Interactive onboarding wizard
- Inbound message debouncing
- Typing indicators and read receipts
- Media (image) support
- Webhook signature verification (HMAC-SHA256)
- Webhook event dedupe by Linq `event_id`
- Multi-account support
- DM policy and allowlist controls
- Pairing code flow for new contacts

## License

MIT
