'use strict';

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  MessageFlags,
} = require('discord.js');

const gtime = require('./gtime');
const db = require('./db');
const stats = require('./stats');
const query = require('./query');
const embeds = require('./embeds');
const welcome = require('./welcome');
const admin = require('./admin');
const config = require('./config');
const { loadCommands } = require('./commandLoader');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// ---------------------------------------------------------------------------
// Cadences.
//
// These were measured against the live cfx.re API (2026-08), not guessed:
//
//  - Each server's JSON is edge-cached with `cache-control: max-age=60`, so the
//    data itself cannot be fresher than 60s. Polling faster only shortens how
//    long we sit on an already-expired value; below ~10s it buys nothing and
//    just re-downloads identical bytes.
//  - ~20 codes fetch in parallel in ~250ms (~22 KB gzipped); 40 concurrent
//    requests to one code returned 200 with no rate limiting.
//  - Discord's message-edit bucket is ~5 requests / 5s per channel, and all
//    four pinned embeds live in one channel - so 5s is the publish floor.
//
// The result: poll fast, but only touch Discord when the rendered content
// actually changed. Idle costs zero edits; a real player-count change reaches
// the embed within POLL_INTERVAL of the API exposing it.
const POLL_INTERVAL = 10 * 1000; // live query cadence (the useful floor)
const RECORD_INTERVAL = 60 * 1000; // snapshot cadence, once per minute per game (hard constraint)
const PUBLISH_MIN_INTERVAL = 5 * 1000; // never edit the pinned embeds faster than this
const PUBLISH_HEARTBEAT = 5 * 60 * 1000; // re-edit even when unchanged, so "Updated" stays honest
const ROLLUP_INTERVAL = 5 * 60 * 1000; // hourly-rollup refresh cadence
const ANALYTICS_TTL = 60 * 1000; // peaks/sparklines only move when a snapshot lands

// servers.json (channels, pinned message ids, watched servers) is
// loaded + normalized by config.js (supports both the nested and the flat
// "codes + pinned" file layouts).
const getConfig = config.getConfig;
const saveConfig = config.saveConfig;

// ---------------------------------------------------------------------------
// Data gathering (live query + local-day analytics)
// ---------------------------------------------------------------------------

// Peaks, daily history and sparklines are derived from recorded snapshots, so
// they only move once a minute no matter how fast we poll. Caching them keeps
// the fast loop from issuing 3 Postgres queries per server per cycle; the live
// player count is still merged in fresh on every single poll.
const analyticsCache = new Map(); // `${game}:${id}` -> { at, todayPeak, peak24h, daily, spark }

async function analyticsFor(game, serverId, now) {
  const key = `${game}:${serverId}`;
  const hit = analyticsCache.get(key);
  if (hit && now - hit.at < ANALYTICS_TTL) return hit;

  const [todayPeak, peak24h, daily] = await Promise.all([
    db.getTodayPeak(game, serverId),
    db.get24hPeak(game, serverId),
    db.getDailyPeaks(game, serverId, 7),
  ]);
  const fresh = { at: now, todayPeak, peak24h, daily, spark: stats.getSparkline(game, serverId, 24) };
  analyticsCache.set(key, fresh);
  return fresh;
}

/** Drop cached analytics for a game so the next read recomputes from snapshots. */
function invalidateAnalytics(game) {
  const prefix = `${game}:`;
  for (const key of analyticsCache.keys()) {
    if (key.startsWith(prefix)) analyticsCache.delete(key);
  }
}

async function decorateServers(game, live, now = Date.now()) {
  return Promise.all(
    live.map(async (s) => {
      const a = await analyticsFor(game, s.id, now);
      const liveNow = s.online ? s.players || 0 : 0;
      return {
        ...s,
        todayPeak: Math.max(a.todayPeak, liveNow),
        peak24h: Math.max(a.peak24h, liveNow),
        daily: a.daily,
        spark: a.spark,
      };
    })
  );
}

async function gatherGameData(game) {
  const cfg = getConfig();
  const live = await query.queryGame(game, cfg.servers[game] || []);
  return decorateServers(game, live);
}

async function gatherAll() {
  const out = {};
  for (const game of query.GAMES) out[game] = await gatherGameData(game);
  return out;
}

// ---------------------------------------------------------------------------
// Pinned status embeds
// ---------------------------------------------------------------------------

const PIN_MARKER = {
  ragemp: 'RAGE MP',
  redm: 'RedM',
  samp: 'SA-MP',
  total: 'Total status',
};

async function fetchPinnedMessages(channel) {
  // discord.js (>=14.21) deprecates fetchPinned() (legacy pins route) in favor
  // of the paginated fetchPins(); prefer the new API, fall back for older builds.
  const mgr = channel.messages;
  if (typeof mgr.fetchPins === 'function') {
    const res = await mgr.fetchPins().catch(() => null);
    if (res && Array.isArray(res.items)) return res.items.map((i) => i.message).filter(Boolean);
  }
  if (typeof mgr.fetchPinned === 'function') {
    const pins = await mgr.fetchPinned().catch(() => null);
    if (pins) return [...pins.values()];
  }
  return [];
}

async function findExistingPinned(channel, key) {
  const marker = PIN_MARKER[key];
  if (!marker) return null;
  const pins = await fetchPinnedMessages(channel);
  return (
    pins.find(
      (m) => m.author && m.author.id === client.user.id && m.embeds[0] && m.embeds[0].title && m.embeds[0].title.includes(marker)
    ) || null
  );
}

/** @returns {Promise<boolean>} whether the embed reached Discord. */
async function upsertPinned(cfg, key, embed) {
  const channelId = cfg.channels[key];
  if (!channelId) return false;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;

  let msg = null;
  const storedId = cfg.messages[key];
  if (storedId) msg = await channel.messages.fetch(storedId).catch(() => null);

  // Recover from the channel's pins if the stored id was lost (e.g. ephemeral FS).
  if (!msg) {
    msg = await findExistingPinned(channel, key);
    if (msg) {
      config.persistPinnedMessage(cfg, key, channelId, msg.id);
    }
  }

  if (msg) {
    const ok = await msg
      .edit({ embeds: [embed] })
      .then(() => true)
      .catch(() => false);
    if (ok) return true;
  }

  const sent = await channel.send({ embeds: [embed] }).catch((e) => {
    console.error(`pinned ${key}: send failed: ${e.message}`);
    return null;
  });
  if (!sent) return false;
  config.persistPinnedMessage(cfg, key, channelId, sent.id);
  sent.pin().catch(() => {});
  return true;
}

/**
 * Everything the reader actually sees, minus the parts that change every time.
 * Two embeds with the same signature would render identically, so editing the
 * message would be a wasted Discord call.
 */
function embedSignature(embed) {
  const json = embed.toJSON();
  delete json.timestamp;
  delete json.footer; // carries the "updated at" clock
  return JSON.stringify(json);
}

const lastSig = {}; // key -> last published signature
const lastPublishAt = {}; // key -> ms
let lastAnyPublishAt = 0;

/**
 * Publish the pinned embeds, editing only the ones whose content moved (or
 * whose heartbeat is due). Returns the number of messages actually edited.
 */
async function publishPinned(cfg, liveByGame, now, opts = {}) {
  const force = !!opts.force;
  if (!force && now - lastAnyPublishAt < PUBLISH_MIN_INTERVAL) return 0;

  const allData = {};
  for (const game of query.GAMES) {
    allData[game] = await decorateServers(game, liveByGame[game] || [], now);
  }

  const built = query.GAMES.map((game) => [game, embeds.buildGameEmbed(game, allData[game], { updatedMs: now })]);
  built.push(['total', embeds.buildTotalEmbed(allData, { updatedMs: now })]);

  let edits = 0;
  for (const [key, embed] of built) {
    if (!cfg.channels[key]) continue;
    const sig = embedSignature(embed);
    const stale = now - (lastPublishAt[key] || 0) >= PUBLISH_HEARTBEAT;
    if (!force && !stale && sig === lastSig[key]) continue;

    // Only remember the signature once it actually landed, so a failed edit is
    // retried on the next poll instead of being treated as already published.
    if (!(await upsertPinned(cfg, key, embed))) continue;
    lastSig[key] = sig;
    lastPublishAt[key] = now;
    edits++;
  }
  if (edits) lastAnyPublishAt = now;
  return edits;
}

/** Force a full re-publish (used by /refresh and the admin panel). */
async function refreshAll() {
  const cfg = getConfig();
  const liveByGame = {};
  for (const game of query.GAMES) {
    liveByGame[game] = await query.queryGame(game, cfg.servers[game] || []);
  }
  await publishPinned(cfg, liveByGame, Date.now(), { force: true });
}

// ---------------------------------------------------------------------------
// Scheduled tick: poll live (POLL_INTERVAL), record snapshots (<=1/min/game),
// publish pinned embeds whenever their content actually changed.
// ---------------------------------------------------------------------------

const lastRecord = {};
let lastRollup = 0;
let ticking = false;

async function tick() {
  if (ticking) return; // never overlap ticks
  ticking = true;
  try {
    const now = Date.now();
    const cfg = getConfig();

    const liveByGame = {};
    for (const game of query.GAMES) {
      try {
        liveByGame[game] = await query.queryGame(game, cfg.servers[game] || []);
      } catch (e) {
        console.error(`query ${game}: ${e.message}`);
        liveByGame[game] = [];
      }
    }

    // Record (rate-limited to once per minute per game). Offline servers are
    // recorded too (players 0, online false) — that is what makes downtime
    // distinguishable from a gap in sampling, and so uptime measurable.
    const meta = [];
    for (const game of query.GAMES) {
      if (now - (lastRecord[game] || 0) >= RECORD_INTERVAL - 1500) {
        const samples = liveByGame[game].map((s) => ({
          id: s.id,
          players: s.online ? s.players || 0 : 0,
          online: !!s.online,
          maxplayers: s.maxplayers || 0,
        }));
        if (samples.length) {
          stats.recordSnapshot(game, samples, now);
          db.recordSnapshot(game, samples, now).catch(() => {});
          invalidateAnalytics(game); // peaks/sparklines just moved
        }
        for (const s of liveByGame[game]) {
          if (!s.online) continue;
          meta.push({
            game,
            id: s.id,
            name: s.name || null,
            address: s.host ? `${s.host}:${s.port}` : null,
            maxplayers: s.maxplayers || 0,
          });
        }
        lastRecord[game] = now;
      }
    }
    // Persist the hostnames the live APIs report, so the panel can show real
    // server names instead of raw cfx join codes.
    if (meta.length) db.upsertServerMeta(meta, now).catch(() => {});

    // Fold recent snapshots into the hourly rollup that long-range analytics
    // and all-time records read from.
    if (now - lastRollup >= ROLLUP_INTERVAL - 1500) {
      lastRollup = now;
      db.rollupHourly(now - 3 * 60 * 60 * 1000).catch(() => {});
    }

    // Publish: every poll, but only the embeds whose content actually moved.
    await publishPinned(cfg, liveByGame, now);
  } finally {
    ticking = false;
  }
}

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember, Partials.User],
});

const { commands } = loadCommands();

// Shared services available to every command via interaction.client.hub.
client.hub = {
  gtime,
  db,
  stats,
  query,
  embeds,
  welcome,
  getConfig,
  saveConfig,
  gatherGameData,
  gatherAll,
  refreshAll,
};

async function registerCommands() {
  const { json } = loadCommands();
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: json });
      console.log(`Registered ${json.length} guild command(s) to ${GUILD_ID}.`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: json });
      console.log(`Registered ${json.length} global command(s).`);
    }
  } catch (e) {
    console.error('Command registration failed:', e.message);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = commands.get(interaction.commandName);
      if (!cmd) return;
      await cmd.execute(interaction);
    } else if (interaction.isModalSubmit()) {
      for (const cmd of commands.values()) {
        if (typeof cmd.ownsModal === 'function' && cmd.ownsModal(interaction.customId)) {
          await cmd.handleModal(interaction);
          return;
        }
      }
    }
  } catch (e) {
    const label = interaction.commandName || interaction.customId || 'interaction';
    console.error(`interaction error (${label}): ${e.message}`);
    if (interaction.isRepliable && interaction.isRepliable()) {
      const payload = { content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral };
      try {
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch {
        /* ignore */
      }
    }
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await welcome.handleMemberJoin(member, { db, logger: console });
  } catch (e) {
    console.error(`guildMemberAdd: ${e.message}`);
  }
});

client.on(Events.Error, (e) => console.error('client error:', e.message));
client.on(Events.Warn, (m) => console.warn('client warn:', m));

let tickTimer = null;
let cleanupTimer = null;

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag} (${c.user.id})`);
  await registerCommands();

  // Kick off scheduling.
  await tick().catch((e) => console.error('initial tick:', e.message));
  tickTimer = setInterval(() => tick().catch((e) => console.error('tick:', e.message)), POLL_INTERVAL);
  console.log(`Polling every ${POLL_INTERVAL / 1000}s; recording every ${RECORD_INTERVAL / 1000}s.`);

  const runCleanup = () =>
    db
      .cleanup(90)
      .then((n) => {
        if (n) console.log(`db cleanup removed ${n} old snapshot row(s)`);
      })
      .catch(() => {});
  runCleanup(); // enforce 90-day retention on boot too, so short-lived instances still prune
  cleanupTimer = setInterval(runCleanup, 24 * 60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  if (tickTimer) clearInterval(tickTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  try {
    await client.destroy();
  } catch {
    /* ignore */
  }
  await db.end();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err && err.message ? err.message : err);
  process.exit(1); // let Railway restart cleanly
});

(async () => {
  // 1. Start the admin panel + /healthz FIRST, before any awaited work, so the
  //    platform healthcheck passes immediately and stays up even if Postgres is
  //    slow or the Discord config is missing. This turns a misconfiguration into
  //    a diagnosable "up but not ready" state instead of a silent crash-loop.
  try {
    admin.start({ client, db, stats, query, gtime, getConfig, saveConfig, refreshAll });
  } catch (e) {
    console.error('admin panel failed to start:', e.message);
  }

  // 2. Bring up Postgres (best-effort; file fallback if unavailable).
  const ok = await db.init();
  if (db.isEnabled()) {
    console.log(`Postgres ${ok ? 'connected' : 'unavailable - using file fallback'}.`);
  } else {
    console.log('Postgres disabled (no DATABASE_URL) - using file fallback.');
  }
  if (ok) {
    // First boot after the analytics rollup was introduced: build it from the
    // snapshot history that already exists, so the panel has depth immediately.
    db.backfillHourly()
      .then((n) => {
        if (n) console.log(`hourly rollup backfilled ${n} row(s) from existing snapshots.`);
      })
      .catch(() => {});
  }

  // 3. Connect to Discord.
  if (!TOKEN || !CLIENT_ID) {
    console.error(
      'TOKEN and/or CLIENT_ID are not set - cannot connect to Discord. ' +
        'The admin panel and /healthz are up; set these variables and redeploy. ' +
        '(/healthz reports "ready": false until the bot connects.)'
    );
    return; // stay alive so /healthz and the logs remain reachable for diagnosis
  }

  await client.login(TOKEN).catch((e) => {
    // A failed login with a token present (bad/rotated token, boot-time network
    // or API failure) is fatal so Railway's restart policy can recover - rather
    // than a silent zombie that keeps answering /healthz while never connecting.
    console.error('Discord login failed:', e.message);
    process.exit(1);
  });
})();
