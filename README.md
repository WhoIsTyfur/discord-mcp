# discord-provisioner-mcp

An MCP (Model Context Protocol) server that lets an AI assistant provision
Discord servers -- guilds, categories, channels, roles, and permission
overwrites -- from a declarative blueprint.

- Talks to the Discord REST API directly (no discord.js); behaviour is
  explicit and dependencies stay thin (`@modelcontextprotocol/sdk` + `zod`).
- Plans before it acts: `apply_blueprint` diffs the blueprint against live
  state, applies only the difference, and never deletes anything.
- Running the same blueprint twice produces zero write operations the second
  time.
- Rate-limit aware: per-bucket queues, global 429 handling, serialised writes
  with a configurable inter-write delay.
- Two transports: stdio (Claude Code and other local clients) and Streamable
  HTTP with bearer auth (claude.ai custom connector).

## Requirements

- Node.js 20+
- A Discord application with a bot token

## Setup

```bash
npm install
npm run build
```

Copy `.env.example` to `.env` (or export the variables however you prefer)
and set at least `DISCORD_BOT_TOKEN`.

| Variable              | Required      | Default | Purpose                                        |
| --------------------- | ------------- | ------- | ---------------------------------------------- |
| `DISCORD_BOT_TOKEN`   | yes           | --      | Bot token from the developer portal            |
| `DISCORD_API_VERSION` | no            | `v10`   | REST API version segment                       |
| `DRY_RUN`             | no            | `false` | `true` = no write request ever reaches Discord |
| `LOG_LEVEL`           | no            | `info`  | `debug`, `info`, `warn`, `error`, `silent`     |
| `WRITE_DELAY_MS`      | no            | `250`   | Minimum delay between consecutive writes       |
| `MCP_AUTH_TOKEN`      | in HTTP mode  | --      | Bearer token HTTP clients must present         |

All logging goes to stderr as JSON lines. In stdio mode stdout carries the
MCP protocol, so nothing else ever writes to stdout. The bot token is
registered with the logger's redaction list and never appears in logs, error
messages, or tool output.

## Creating the Discord application and bot

1. Go to https://discord.com/developers/applications and click New
   Application.
2. Open the Bot tab and click Reset Token to reveal the bot token. Store it
   as `DISCORD_BOT_TOKEN`. Treat it like a password.
3. No privileged gateway intents are needed; this server uses REST only.

### Inviting the bot to an existing server

Use an OAuth2 URL with the `bot` scope. Minimum permissions for this server's
tools: Manage Channels, Manage Roles, View Channels. That permission set is
the integer `268436496` (`MANAGE_CHANNELS 16 + VIEW_CHANNEL 1024 +
MANAGE_ROLES 268435456`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot&permissions=268436496
```

The person clicking the link needs Manage Server on the target guild.

### Two gotchas worth knowing up front

- **10-guild limit on `create_guild`.** Discord only lets a bot create
  guilds while it is a member of fewer than 10. `get_bot_info` reports your
  headroom, and `create_guild` fails with a clear message when over the
  limit. The normal path at scale: create the server manually, invite the
  bot, then run `apply_blueprint`.
- **Role hierarchy.** A bot can only manage roles strictly below its own
  highest role. If role creation or overwrite calls fail with Missing
  Permissions (50013) or 403 even though the bot has Manage Roles, drag the
  bot's role above the roles it manages in Server Settings -> Roles. This is
  the most common confusing failure; the error hint calls it out.

## Running

### stdio (default)

```bash
node dist/index.js
```

or during development:

```bash
npm run dev
```

The stdio server belongs to the process that started it. It exits 0 when
stdin ends or closes, on SIGHUP, SIGTERM or SIGINT, and when the parent
process disappears (checked every 15 seconds), so an ended session never
leaves a node process behind.

### Streamable HTTP

```bash
MCP_AUTH_TOKEN=some-long-random-string node dist/index.js --http --port 3000
```

- Endpoint: `POST/GET/DELETE http://127.0.0.1:3000/mcp` (plus `GET /healthz`,
  unauthenticated).
- Every `/mcp` request must send `Authorization: Bearer <MCP_AUTH_TOKEN>`;
  anything else gets a 401. The comparison is constant-time.
- Sessions follow the Streamable HTTP spec: the `initialize` response carries
  an `mcp-session-id` header, later requests echo it, `DELETE` ends the
  session.
- Binds `127.0.0.1` by default; pass `--host 0.0.0.0` to expose it (put TLS
  in front first).

## Registering with Claude Code

```bash
claude mcp add discord \
  -e DISCORD_BOT_TOKEN=your-bot-token \
  -- node /absolute/path/to/discord-mcp/dist/index.js
```

Or in a project `.mcp.json`:

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/absolute/path/to/discord-mcp/dist/index.js"],
      "env": {
        "DISCORD_BOT_TOKEN": "your-bot-token"
      }
    }
  }
}
```

## Registering as a claude.ai custom connector

1. Run in HTTP mode behind a public HTTPS URL (reverse proxy or tunnel --
   e.g. Cloudflare Tunnel -- terminating TLS in front of `--http --port 3000`).
2. In claude.ai: Settings -> Connectors -> Add custom connector, and give it
   `https://your-host/mcp`.
3. Auth caveat: the custom connector UI does not let you attach an arbitrary
   static bearer header. If your connector setup cannot send
   `Authorization: Bearer <MCP_AUTH_TOKEN>`, put the token injection in the
   fronting proxy (add the header there) and restrict who can reach the
   proxy. Do not expose the server without the bearer check.

## Tool surface

Read:

| Tool            | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `list_guilds`   | Guilds the bot is in                                           |
| `get_guild`     | Guild settings + full role list (permissions decoded to names) |
| `list_channels` | All channels incl. categories, overwrites decoded              |
| `list_roles`    | All roles, highest first                                       |
| `get_bot_info`  | Bot identity, guild count, 10-guild headroom                   |
| `get_blueprint_template` | Ready-made blueprints for common community types      |

Write:

| Tool                      | Purpose                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `create_guild`            | `POST /guilds` -- whole structure in one request via a blueprint |
| `apply_blueprint`         | The main tool: diff blueprint vs live state, apply the diff      |
| `create_role`             | One role; permissions as names, color as hex                     |
| `create_channel`          | One channel/category, with optional overwrites                   |
| `set_channel_permissions` | Set (replace) one role/member overwrite on a channel             |
| `reorder_channels`        | Bulk channel positions / parents                                 |
| `reorder_roles`           | Bulk role positions                                              |

Destructive (gated -- both require `confirm: true` and say so in their
descriptions; there is deliberately no `delete_guild` tool at all):

| Tool             | Purpose                          |
| ---------------- | -------------------------------- |
| `delete_channel` | Permanently delete a channel     |
| `delete_role`    | Permanently delete a role        |

Every tool returns structured JSON text. Failures return an MCP error result
carrying the Discord error code, message, field details, and an actionable
hint -- never a thrown exception that kills the process. Every write sends an
`X-Audit-Log-Reason` header so actions are traceable in the guild's audit
log.

## Server design layer

The server ships opinionated design knowledge so assistants produce sensible
layouts instead of inventing conventions per request:

- **Templates** -- `get_blueprint_template` returns a complete starter
  blueprint for a community type: `gaming`, `dev`, `support`, or `creator`.
  Call it without arguments to list them. Each follows the conventions
  below (INFORMATION category first, locked info channels, Admin > Mod >
  status > Member ladder, private STAFF area, sane @everyone baseline).
- **Design guide** -- the MCP resource `discord://design-guide`
  (markdown): category ordering, standard channels, role ladders,
  permission patterns, guild settings, and the dry-run-first workflow.
- **Prompt** -- the MCP prompt `design_server` (arguments:
  `community_type`, `requirements`) bundles the guide plus the matching
  template into a single message, for clients with prompt support.

Typical flow: assistant lists templates, fetches the closest one, tailors
names/roles/channels to the request, then runs `apply_blueprint` with
`dry_run: true` for review before writing.

## Blueprint format

A blueprint is a JSON object (the `blueprint` parameter also accepts a JSON
string). YAML shown here for readability -- it maps 1:1 onto the JSON; if you
author in YAML, convert it to JSON before passing it in (no YAML parser is
bundled, by design, to keep dependencies thin).

```yaml
name: "Example Server"
everyone_permissions: [VIEW_CHANNEL, READ_MESSAGE_HISTORY]
roles:
  - name: "Admin"
    color: "#e74c3c"
    hoist: true
    permissions: [ADMINISTRATOR]
  - name: "Member"
    permissions: [VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY, ADD_REACTIONS]
categories:
  - name: "INFORMATION"
    private_to: []              # empty = public
    channels:
      - name: "announcements"
        type: announcement
        locked: true            # shorthand: @everyone denied SEND_MESSAGES
      - name: "rules"
        type: text
        locked: true
  - name: "STAFF"
    private_to: [Admin]         # shorthand: @everyone denied VIEW_CHANNEL, Admin allowed
    channels:
      - name: "staff-chat"
        type: text
```

### Field reference

Root:

| Field                           | Type            | Notes                                            |
| ------------------------------- | --------------- | ------------------------------------------------ |
| `name`                          | string (2-100)  | Guild name (used by `create_guild`)              |
| `everyone_permissions`          | permission[]    | Baseline permissions of the `@everyone` role     |
| `roles`                         | role[]          | Order = role list order, top first               |
| `categories`                    | category[]      | Order = category order                           |
| `channels`                      | channel[]       | Top-level channels outside any category          |
| `icon`                          | data URI        | `data:image/png;base64,...` (create_guild only)  |
| `verification_level`            | 0-4             | Optional guild setting                           |
| `default_message_notifications` | 0-1             | Optional guild setting                           |
| `explicit_content_filter`       | 0-2             | Optional guild setting                           |
| `afk_timeout`                   | 60/300/900/1800/3600 | Optional guild setting                      |
| `system_channel`                | channel name    | Must be a text/announcement channel defined here |
| `afk_channel`                   | channel name    | Must be a voice channel defined here             |

Role: `name` (required), `color` (hex string), `hoist`, `mentionable`,
`permissions` (array of permission names).

Category: `name` (required), `private_to`, `locked`, `overwrites`,
`channels`.

Channel: `name` (required), `type` (`text` default, `voice`, `announcement`,
`stage`, `forum`, `media`), `topic`, `nsfw`, `rate_limit_per_user`,
`locked`, `private_to`, `overwrites`.

Overwrite (the escape hatch when shorthands are not enough):

```yaml
overwrites:
  - role: "Member"          # a role name from roles[], or "@everyone"
    allow: [VIEW_CHANNEL]
    deny: [SEND_MESSAGES]
```

Permission names are the documented Discord constants (`VIEW_CHANNEL`,
`SEND_MESSAGES`, `MANAGE_ROLES`, `MODERATE_MEMBERS`, ...). An unknown name
fails validation with the full list of valid options. Bit positions are
verified against the current Discord docs; bitfields are computed with
BigInt and serialised as strings, never JavaScript numbers.

### Semantics

- **Roles are referenced by name** everywhere (in `private_to` and
  `overwrites`). Resolution to snowflake ids happens at apply time. A
  reference to a role not defined in `roles[]` is a validation error caught
  before any API call.
- **`private_to: [RoleA]`** denies `VIEW_CHANNEL` for `@everyone` and allows
  it for each listed role -- the standard private-channel pattern. An empty
  array means public.
- **`locked: true`** denies `SEND_MESSAGES` for `@everyone`.
- **Category inheritance.** A child channel that states nothing
  overwrite-related inherits the category's overwrites exactly (the way
  Discord's UI syncs new channels to their category). A child that states
  anything merges with the category per role and per bit, and the child wins
  on conflicts. So `locked: true` inside a private category keeps the
  privacy and adds the lock, and an explicit
  `overwrites: [{ role: "@everyone", allow: [VIEW_CHANNEL] }]` can punch a
  public window into a private category.
- **Contradictions are errors.** Allowing and denying the same permission
  for the same role at the same level fails validation.
- **Omitted fields are unmanaged.** A role without `permissions` (or a
  channel without `topic`) is created with Discord defaults and never
  diffed, so reconcile will not fight manual changes to fields the
  blueprint does not mention. State a field to manage it.
- **Channel names are normalised** the way Discord stores them: text-like
  channels become lowercase-kebab (`"Staff Chat"` -> `staff-chat`). Matching
  and idempotency use the normalised name. Duplicate normalised names within
  the same category are a validation error.

## Planning, idempotency, orphans

`apply_blueprint(guild_id, blueprint, mode, dry_run)`:

1. Validates the blueprint (schema, role references, contradictions). This
   is a separate pass; nothing is fetched or written if it fails.
2. Fetches live roles and channels.
3. Matches blueprint entities to live entities by name and produces an
   ordered plan: `@everyone` permissions -> create roles -> update roles ->
   set role positions -> create categories -> create channels -> update
   channels -> apply overwrites.
4. Skips anything that already matches; in `reconcile` mode updates anything
   that differs; in `create_only` mode (the default, the conservative
   choice) only creates what is missing and reports differing entities under
   `skipped`.
5. **Never deletes anything.** Live roles/channels the blueprint does not
   mention are reported under `orphans` for you to decide about (the gated
   delete tools exist for that).

`dry_run: true` validates everything and returns the full ordered plan
without a single write call. `DRY_RUN=true` in the environment forces this
for every write tool in the server, with a second guard at the HTTP client
level -- both are covered by tests.

Applying the same blueprint twice yields zero operations the second time
(tested at both the planner and the full-tool level).

Overwrite management scope: on channels the blueprint defines, role-type
overwrites for roles the blueprint knows about (and `@everyone`) are fully
converged -- including removing ones the blueprint no longer wants.
Member-type overwrites and overwrites for roles outside the blueprint are
never touched.

If an apply fails partway (e.g. a permission error), it stops, reports what
was applied and what failed, and re-running is safe -- the next run diffs
from wherever things stand.

## Rate limiting

Provisioning a server means dozens of rapid writes, so the client:

- Tracks `X-RateLimit-Bucket`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset-After`, and serialises requests sharing a bucket.
- On 429 reads `retry_after` from the JSON body and sleeps; a 429 with
  `X-RateLimit-Scope: global` pauses ALL requests, not just that bucket.
  Gives up after 10 consecutive 429s on one request.
- Retries 5xx and network errors with jittered exponential backoff, max 5
  attempts. Never retries any other 4xx.
- Serialises ALL writes through a single queue with `WRITE_DELAY_MS`
  (default 250 ms) between them, because role/channel creation is limited
  far more aggressively than reads. Raise it if you still see 429s.

## Error mapping

Discord's numeric `code` and nested `errors` field paths are surfaced on
every failure, plus a hint for the common cases:

| Code / status | Meaning                  | Hint                                                        |
| ------------- | ------------------------ | ----------------------------------------------------------- |
| 50001         | Missing Access           | Bot cannot see the guild/channel; check membership and VIEW_CHANNEL |
| 50013         | Missing Permissions      | Bot lacks Manage Roles/Channels, or the target role is at/above the bot's top role |
| 30013         | Max guilds               | The 10-guild bot creation limit; invite the bot to an existing server instead |
| 30005 / 30011 / 30xxx | Resource limits  | Role (250) / channel (500) / other Discord limits           |
| 50035         | Invalid Form Body        | Includes the exact field path(s) from Discord's response    |
| 401           | Bad token                | Re-copy `DISCORD_BOT_TOKEN` from the portal                 |
| 403           | Forbidden                | Usually role hierarchy -- move the bot's role up            |

## Development

```bash
npm run dev        # tsx, stdio mode
npm test           # vitest; the HTTP layer is stubbed, no network calls
npm run typecheck
npm run build
```

## Decisions and assumptions

Choices made where the spec left room, leaning conservative:

- `apply_blueprint` defaults to `create_only`; `reconcile` is opt-in.
- Nothing is ever deleted by the blueprint path; orphans are reported only.
  Member-type overwrites and overwrites for non-blueprint roles are
  preserved even in reconcile.
- Omitted blueprint fields (role `permissions`, channel `topic`, ...) are
  unmanaged rather than treated as "set to default".
- Blueprint `roles` order defines the top-to-bottom role order. Reconcile
  fixes relative order; `create_only` never repositions existing roles.
  Existing channels are not repositioned by reconcile either (creation sets
  positions; use `reorder_channels` for manual fixes).
- A live channel whose type differs from the blueprint's is reported as a
  `conflict` (Discord cannot convert most types); no action is taken.
- Blueprints arrive as JSON (object or string). YAML is documentation-side
  only, to avoid another dependency.
- 429s are retried up to 10 times per request; 5xx up to 5 attempts.
- Apply stops at the first failed operation rather than continuing blind.
- HTTP mode binds `127.0.0.1` unless `--host` says otherwise, and refuses to
  start without `MCP_AUTH_TOKEN`.
- Bot-integration (managed) roles are never matched, updated, or listed as
  orphans.

## Security notes

- The bot token and MCP auth token are redacted from every log line as a
  last line of defense; they are never placed in tool output or error
  messages in the first place.
- `delete_channel` / `delete_role` require `confirm: true` and are labelled
  irreversible; there is no `delete_guild` tool.
- Prefer `DRY_RUN=true` plus `apply_blueprint(dry_run: true)` to review the
  plan before letting it write.
