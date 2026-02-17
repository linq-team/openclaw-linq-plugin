# openclaw-linq-plugin

Linq iMessage channel plugin for [OpenClaw](https://github.com/openclaw/openclaw). Send and receive real iMessage (blue bubbles) through the [Linq API](https://linqapp.com) — no Mac required.

## Installation

```bash
openclaw plugins install github:linq-team/openclaw-linq-plugin
```

## Setup

Run the interactive setup wizard:

```bash
openclaw channels add --channel linq
```

The wizard will walk you through:

1. **API token** — sign up at [linqapp.com](https://linqapp.com) and copy your token from the dashboard
2. **Phone number** — the Linq phone number shown in your dashboard (E.164 format, e.g. `+15551234567`)
3. **Webhook config** — URL, path, and host for inbound message delivery (defaults to `http://localhost:3100/linq-webhook`)

You can also set `LINQ_API_TOKEN` as an environment variable instead of storing the token in config.

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
      "apiToken": "your-token",
      "fromPhone": "+15551234567",
      "dmPolicy": "open",
      "webhookUrl": "http://localhost:3100/linq-webhook",
      "webhookPath": "/linq-webhook",
      "webhookHost": "0.0.0.0"
    }
  }
}
```

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
          "apiToken": "token-1",
          "fromPhone": "+15551111111"
        },
        "support": {
          "enabled": true,
          "apiToken": "token-2",
          "fromPhone": "+15552222222"
        }
      }
    }
  }
}
```

### DM policy

Control who can message your agent:

- `"open"` (default) — anyone can message
- `"pairing"` — new senders must enter a pairing code
- `"disabled"` — no inbound DMs

### Webhook security

Set a `webhookSecret` to enable HMAC signature verification on inbound webhooks:

```json
{
  "channels": {
    "linq": {
      "webhookSecret": "your-secret"
    }
  }
}
```

## Features

- Real iMessage blue bubbles via Linq API
- Interactive onboarding wizard
- Inbound message debouncing
- Typing indicators and read receipts
- Media (image) support
- Webhook signature verification (HMAC-SHA256)
- Multi-account support
- DM policy and allowlist controls
- Pairing code flow for new contacts

## License

MIT
