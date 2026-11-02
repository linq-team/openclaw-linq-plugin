# Linq plugin verification

Verification on 2026-11-02 uses the published **OpenClaw 2026.10.9** npm
package (release build `8b18b55`) with Node **26.12.1**. npm's `latest` tag
and the upstream GitHub latest stable release both selected 2026.10.9.
The starting repairs are `db0ad3531e4331f06ab42c2b26b8cc2d29cba324`.

## Minimum supported host

The minimum is **OpenClaw 2026.10.1**, independently of the 2026.10.9
build/development target and live-test version. Both npm peer compatibility and
`openclaw.compat.pluginApi` declare `>=2026.10.1`.

The unmodified implementation typechecks on 2026.9.6, but that host rejects
`openChannelIngressQueue` for this external plugin with `PLUGIN_TRUST_REFUSED`.
The same trusted-only queue gate remains in the 2026.9.36 extended-stable package.
2026.9.5 also lacks `runtime.channel.inbound.ingress`; still older hosts lack
additional APIs. No fallback to a non-durable receive path is used.

2026.10.1 is the first stable 2026.10 release and removes that legacy queue gate.
On its published package, typecheck, all 63 tests, build, SecretRef discovery,
durable restart/replay and sender-policy fixtures, and the actual Gateway
text/image/model/automatic-reply fixture pass. The compiled tarball is also
installed and checked separately on this minimum host. No phone-backed live
verification is claimed on 2026.10.1; the handset proof below uses 2026.10.9.

## Automated evidence

- Typecheck, 63 tests across 16 files, and compiled build pass.
- The released host loader verifies runtime registration, cold setup and
  pre-runtime SecretRef discovery/materialization.
- Signed HTTP admission waits for SQLite persistence; duplicate admission,
  process exit before completion, recovery in a new process and completed-event
  replay suppression pass.
- Host pairing, allowlist, open and disabled sender decisions pass.
- A real isolated Gateway receives signed synthetic text/photo webhooks,
  routes authorized messages through the agent/model pipeline, supplies image
  bytes to a deterministic model, and sends automatic replies through the
  durable message adapter to a simulated Linq API. Unsigned requests are
  rejected, and replayed/denied text messages do not invoke the model or send.
- Incoming-media regressions cover download after authorization, bounded HTTPS
  staging, local media facts and failed staging without agent dispatch.
- Existing fixtures cover outgoing media upload, quoted replies, best-effort
  presence, rate limits, ambiguous outcomes, storage failures and account scope.

`npm run check` runs these checks. The Gateway fixture replaces provider
requests and the attachment response; it does not contact a real Linq account
and cannot prove provider transport or phone delivery. It uses a test-only
fetch injection marker supported by the host's mocked-fetch boundary.

The actual tarball is installed with the released CLI into a separate state/config
directory. Both integration harnesses also support `LINQ_PACKAGE_ROOT` to
verify this installed artifact, with no normal Gateway configuration changes.

## Defect found during this verification

Incoming attachments previously entered the host context as URL-only facts.
The real Gateway reported that media could not be staged without a path, and
the model received no image bytes despite producing a reply. The plugin now
downloads authorized attachments with the public SDK's SSRF-guarded media
store, a 100 MiB per-file limit and a 30-second deadline, and passes local
paths to the host. Staging failures retain the event for durable retry and
use a generic error to avoid exposing attachment URLs. The Gateway image-byte
assertion failed before this change and passes after it.

## Live evidence on the same released host

The restored sandbox was exercised through the installed tarball and the actual
Gateway lifecycle on 2026-11-02. The agent used a local deterministic model
fixture; the Linq API, signed webhooks, media downloads/uploads and phone were
real. Model-request instrumentation recorded media types and decoded byte counts,
not private text or image content.

- A new test-owned `message.received` subscription was scoped to the provisioned
  line and pinned to webhook version `2026-02-03`. The public HTTPS proxy exposed
  only the exact webhook route: GET returned 405, unsigned POST returned 401,
  and other paths returned 404. Existing subscriptions were preserved.
- A real incoming SMS text passed signature enforcement and sender/line checks,
  reached the agent/model, and produced an automatic reply confirmed on the
  handset. Provider API acceptance was recorded separately from this confirmation.
- The first phone settings had iMessage disabled. Linq's capability check returned
  unavailable, and actual messages used SMS. The handset displayed green bubbles;
  an explicit quoted request arrived as ordinary SMS. The early photo attempt
  ultimately failed on the phone and never appeared in the provider chat/events.
  Early outbound PNG requests were accepted as SMS, but no handset image arrived.
- After the operator enabled iMessage, the capability check returned available.
  Fresh incoming text and normal camera JPEG photos arrived as signed iMessage
  events, were authorized, staged locally, and dispatched to the actual agent.
- The model request contained two native image data blocks from the real camera
  photos, decoded to 180,819 and 164,571 bytes after host processing. A first local
  fixture counter inspected only the final user message and undercounted images;
  examining all messages corrected this harness mistake without a plugin change.
- Automatic iMessage replies were sent through the durable channel adapter.
  The provider recorded delivered/read status for replies. The operator confirmed
  receipt of the automatic photo acknowledgment as an iMessage,
  the outbound blue/white PNG on the handset, visible typing, and a read receipt
  on the incoming image. Read/typing behavior remains best-effort.
- An explicit iMessage quoted-reply request retained the provider message-id
  reference and reached delivered/read status. The operator confirmed it appeared
  linked to the earlier text on the handset.
- A synthetic, freshly signed replay of the completed real SMS event was accepted
  before and after a full Gateway restart, with no additional model call or send.
  Pending-event crash recovery and adverse sender policies remain automated host
  fixture evidence, rather than disruptive phone tests.

## Limits and cleanup

This proves channel transport/routing and media input with a deterministic model,
not live-model reasoning or visual understanding. RCS was unavailable in the
capability check and was not exercised. SMS/MMS image delivery was not established;
quoted threading, visible typing and read receipts were established only where
supported by iMessage. No groups or other unsupported features were tested.

Only the approved phone was targeted. The test-owned subscription was deleted and
both pre-existing subscriptions were verified present. The test tunnel, proxy,
model fixture and isolated Gateway were stopped after handset confirmation.
Normal Gateway configuration was not changed. No npm/ClawHub release or merge is
part of this verification.
