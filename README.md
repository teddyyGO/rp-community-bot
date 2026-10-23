# rp-community-bot

A Discord bot for game-server communities. It does two jobs:

1. **Live player-count tracking** for **RageMP**, **RedM/FiveM** and **SA-MP**
   servers. It keeps pinned status embeds up to date (one per game plus a
   combined total) showing current players, today's peak, the 24h peak, daily
   peaks for the last 7 days, and sparklines.
2. **Welcome flow**: when someone joins, it can send them a DM, post a short
   message in a channel, attach a rendered welcome card, assign auto-roles, and
   write an audit-log line. Messages support template variables.

It also runs a web **admin panel** with a stats and analytics dashboard, a
per-guild welcome editor, and a public `/healthz` endpoint.

## Stack

- Node.js 18 or newer, [discord.js](https://discord.js.org) v14
- Express for the admin panel and health check
- PostgreSQL via `pg` for long-term storage. Postgres is optional: if it is
  missing or goes down, the bot falls back to local JSON files.
- `@napi-rs/canvas` for welcome-card rendering. It is loaded only when a card is
  rendered.

## Quick start

```bash
npm install
cp .env.example .env                      # fill in TOKEN, CLIENT_ID, ADMIN_KEY
cp servers.example.json servers.json      # list your servers + channels
npm start                                 # registers slash commands on boot
```

`npm run deploy-commands` registers the commands on its own, without starting
the bot.

### Discord setup

- Turn on the **Server Members Intent** in the Developer Portal. The welcome
  flow needs `GuildMemberAdd`.
- Give the bot these permissions: **View Channel**, **Send Messages**, **Embed
  Links**, **Attach Files**, **Manage Messages** (to pin the status embeds),
  and **Manage Roles** (for auto-roles and the notification role).

## Configuration

### Environment variables

| Variable | Purpose |
|---|---|
| `TOKEN` | Discord bot token (required; never commit it) |
| `CLIENT_ID` | Application id, used to register slash commands (required) |
| `GUILD_ID` | Optional. Registers commands to a single guild so changes show up instantly during development |
| `ADMIN_KEY` | Admin panel password (required for the panel). Use a long random value |
| `COMMUNITY_NAME` | Display name used in embeds and the panel (default `RP Community Hub`) |
| `UTC_OFFSET_HOURS` | The community's clock as a fixed offset from UTC, with no DST (default `0`) |
| `DAY_START_HOUR` | Local hour when the "day" starts for daily peaks (default `6`, so a 02:00 session counts toward the previous night) |
| `SERVERS_CONFIG` | Path to the servers file (default `./servers.json`) |
| `SERVERS_JSON` | Inline JSON with the same shape, used when the file does not exist (for hosts with an ephemeral filesystem) |
| `DATABASE_URL` | Postgres connection string (optional) |
| `PORT` / `ADMIN_PORT` | Port for the panel and health check (default `3000`) |
| `SESSION_SECRET` | Optional extra secret for signing the session cookie |
| `SESSION_EPOCH` | Change it to any new value to revoke every admin session |

### Servers file (`servers.json`)

```json
{
  "pingRoleId": "",
  "ragemp": ["play.example.com:22005"],
  "redm": ["abc123"],
  "samp": ["samp.example.com:7777"],
  "pinned": {
    "ragemp": { "channelId": "", "messageId": "" },
    "total":  { "channelId": "", "messageId": "" }
  }
}
```

- **RageMP**: player counts come from the official masterlist, so `host:port`
  must match the server's masterlist entry exactly.
- **RedM/FiveM**: use either a **cfx.re join code**, which is looked up through
  the public cfx servers API, or a direct `host:port`, which is queried at
  `/dynamic.json`. The cfx API blocks some datacenter IP ranges. If your host is
  blocked, use a direct `host:port` instead.
- **SA-MP**: queried over the UDP query protocol on the game port.
- `pinned.<game>.channelId` turns on the auto-updating pinned embed for that game
  (or for `total`). The bot fills in `messageId` itself. If that id is lost, for
  example on a host whose filesystem is wiped on redeploy, the bot finds its
  existing pinned message again so it doesn't post a duplicate.
- `pingRoleId` is the role that `/notify` and `/unnotify` give and remove.

There is also a nested layout,
`{ channels, messages, pingRoleId, servers: { game: [{ id, name, host, port } | { code }] } }`.
It is documented in `config.js`.

The bot polls every 10 seconds and records one snapshot per game per minute. It
edits a pinned embed only when the rendered content has changed, plus a
heartbeat edit every 5 minutes.

## Commands

| Command | Description |
|---|---|
| `/ragemp` `/redm` `/samp` | On-demand status embed for one game |
| `/total` | Combined status across all games |
| `/summary` | Compact text overview |
| `/refresh` | Force-refresh the pinned embeds *(Manage Server)* |
| `/notify` `/unnotify` | Give yourself, or remove, the notification role |
| `/message` | Post a message as the bot *(Manage Server; you must be able to post in the target channel)* |
| `/ping` | Latency |

## Admin panel

You sign in with `ADMIN_KEY` and get an HMAC-signed, `HttpOnly`, `SameSite=Lax`
session cookie, marked `Secure` over HTTPS. Failed logins are throttled per IP.
State-changing requests must come from the panel's own origin, and pages send
anti-framing and `nosniff` headers.

- **Dashboard**: bot, DB and storage status, plus a cached view of each server.
- **Stats** (`/stats`): overview KPIs, a concurrent-players chart with
  drag-to-zoom, daily peaks, a weekday × hour heatmap, a leaderboard,
  server-vs-server comparison, peak-time analysis, per-server detail, and CSV
  exports. The charts come from a small dependency-free SVG library in
  `public/`, with no CDN.
- **Welcome** (`/welcome/<guildId>`): DM and channel messages, target and
  log channels, auto-roles, and a layered **welcome-card editor**
  (background, avatar, text and image layers).

The read-only JSON API sits behind the same session: `/api/stats/servers`,
`summary`, `series`, `profile`, `daily`, `records`, `compare`, `health`,
`export.csv`.

## Welcome messages

- The **DM** is the long-form welcome. YouTube URLs are left bare so they embed;
  every other URL is wrapped in `<>` so it doesn't. If the member's DMs are
  closed, the DM is skipped and the skip is logged.
- The **channel post** is the short welcome. It can only ping the member who
  joined: `@everyone`, `@here` and role mentions are suppressed, even when they
  come from a display name.
- **Variables** are substituted in a single pass, so a value such as a username
  is never expanded again:

```
${userid} ${usertag} ${username} ${userglobalnickname} ${usernickname}
${userdisplayname} ${usermention} ${useravatarurl} ${userserveravatarurl}
${usercreatedat} ${usercreatedtimestamp} ${userjoinedat} ${userjoinedtimestamp}
${nowtimestamp} ${guildid} ${guildname} ${guildiconurl} ${guildbannerurl}
${guildmembercount} ${guildvanitycode}
```

The `…at` variables render as Discord timestamps (`<t:…:F>`). The `…timestamp`
variables are raw Unix milliseconds.

## Storage

| Tier | Resolution | Retention | Used for |
|---|---|---|---|
| `snapshots` (Postgres) | 1/min/server | 90 days | live views, short ranges |
| `server_hourly` (Postgres) | 1/hour/server | 3 years | long ranges, peak-time profiles, all-time records |
| `stats.json` (local) | 1/min/server | ~8 days | embeds, and the fallback when Postgres is down |

Per-guild welcome config is written to `guild-config.json` first and then
mirrored to Postgres. Server names reported by the live APIs are cached in
`server_meta` / `server-meta.json`.

## Deploying

`railway.toml` sets a memory-capped start command and a `/healthz` healthcheck.
The panel and `/healthz` start before the Discord login. If `/healthz` reports
`"ready": false`, the process is running but `TOKEN`/`CLIENT_ID` are missing or
the login failed, so check the logs. On hosts with an ephemeral filesystem, put
the servers config in `SERVERS_JSON`.

## Project layout

```
index.js            entry point: polling, snapshots, pinned embeds, events
admin.js            Express admin panel, auth, welcome editor, /healthz
admin-stats.js      /stats page, JSON API, CSV export
analytics.js        panel metrics (series, profiles, records, comparison)
public/             panel assets (charts.js, stats.js, panel.css)
db.js               Postgres pool, schema, snapshots, rollups, guild config
stats.js            file-backed store + local fallbacks for every query
query.js            RageMP / RedM / SA-MP live queries
embeds.js           status embed builders
welcome.js          welcome variables, URL processing, join handler
card.js             welcome-card renderer
gtime.js            fixed-offset community-time helpers
config.js           servers-config loader
commands/           slash commands
```

## License

[MIT](LICENSE)
