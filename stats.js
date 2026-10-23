'use strict';

/**
 * File-backed snapshot store + LOCAL FALLBACKS for every analytic DB query.
 *
 * The bot must keep working when Postgres is unreachable, so every analytic
 * function db.js exposes has a twin here that computes the same answer from
 * stats.json. stats.json is also the *primary* source for the status embeds.
 *
 * Two JSON files live next to this module:
 *   stats.json        - rolling ~8-day snapshot cache (one entry per game/min)
 *   guild-config.json - per-guild welcome config (cache + DB-down fallback)
 *
 * Both are cached in-memory and only re-read when their mtime changes.
 */

const fs = require('fs');
const path = require('path');
const g = require('./gtime');

const STATS_PATH = path.join(__dirname, 'stats.json');
const GUILD_PATH = path.join(__dirname, 'guild-config.json');
const META_PATH = path.join(__dirname, 'server-meta.json');

// Keep ~8 days so the "last 7 local days" view is always fully covered.
const RETENTION_MS = 8 * g.DAY_MS;

// ---------------------------------------------------------------------------
// Generic mtime-cached JSON file
// ---------------------------------------------------------------------------

function makeStore(filePath, makeDefault) {
  let cache = null;
  let cacheMtime = -1;

  function load() {
    let mtime;
    try {
      mtime = fs.statSync(filePath).mtimeMs;
    } catch {
      // No file yet.
      if (!cache) cache = makeDefault();
      return cache;
    }
    if (cache && mtime === cacheMtime) return cache;
    try {
      cache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      // Corrupt/partial read - fall back to last good cache or a default.
      if (!cache) cache = makeDefault();
      return cache;
    }
    cacheMtime = mtime;
    return cache;
  }

  function save(data) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, filePath); // atomic replace
    cache = data;
    try {
      cacheMtime = fs.statSync(filePath).mtimeMs;
    } catch {
      cacheMtime = -1;
    }
  }

  function bytes() {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  return { load, save, bytes, get path() { return filePath; } };
}

const statsStore = makeStore(STATS_PATH, () => ({ version: 1, snapshots: {} }));
const guildStore = makeStore(GUILD_PATH, () => ({ version: 1, guilds: {} }));
const metaStore = makeStore(META_PATH, () => ({ version: 1, servers: {} }));

// ---------------------------------------------------------------------------
// Snapshot store
// ---------------------------------------------------------------------------

/** Internal: get the (mutable, normalized) snapshot array for a game. */
function gameSnaps(data, game) {
  if (!data.snapshots) data.snapshots = {};
  if (!Array.isArray(data.snapshots[game])) data.snapshots[game] = [];
  return data.snapshots[game];
}

/**
 * Append one snapshot for a game.
 *
 * Online servers land in `p` (id -> players); servers that were polled but were
 * *down* land in `d` (a list of ids), which is what makes uptime measurable —
 * without it a downtime is indistinguishable from a gap in sampling.
 *
 * @param {string} game
 * @param {Array<{id:string,players:number,online?:boolean}>} samples
 * @param {number} tsMs
 */
function recordSnapshot(game, samples, tsMs = g.nowMs()) {
  const data = statsStore.load();
  const arr = gameSnaps(data, game);
  const p = {};
  const d = [];
  for (const s of samples) {
    if (!s || s.id == null) continue;
    if (s.online === false) {
      d.push(String(s.id));
    } else if (Number.isFinite(s.players) && s.players >= 0) {
      p[s.id] = s.players;
    }
  }
  arr.push(d.length ? { t: tsMs, p, d } : { t: tsMs, p });

  // Prune anything older than the retention window (across all games).
  const cutoff = tsMs - RETENTION_MS;
  for (const key of Object.keys(data.snapshots)) {
    data.snapshots[key] = data.snapshots[key].filter((e) => e.t >= cutoff);
  }

  statsStore.save(data);
  return true;
}

/** Most recent recorded count for a server, or null if none. */
function getLatest(game, serverId) {
  const arr = gameSnaps(statsStore.load(), game);
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i].p[serverId];
    if (v != null) return { players: v, ts: arr[i].t };
  }
  return null;
}

/** Max players for a server within a [fromMs, +inf) window. */
function peakSince(game, serverId, fromMs) {
  const arr = gameSnaps(statsStore.load(), game);
  let peak = 0;
  let seen = false;
  for (const e of arr) {
    if (e.t < fromMs) continue;
    const v = e.p[serverId];
    if (v != null) {
      seen = true;
      if (v > peak) peak = v;
    }
  }
  return seen ? peak : 0;
}

/** Peak today (current local day, DAY_START_HOUR boundary). */
function getTodayPeak(game, serverId, nowMs = g.nowMs()) {
  return peakSince(game, serverId, g.localDayStart(nowMs));
}

/** Peak over the last rolling 24 hours. */
function get24hPeak(game, serverId, nowMs = g.nowMs()) {
  return peakSince(game, serverId, nowMs - g.DAY_MS);
}

/**
 * Daily peaks for the last `days` local days (oldest first).
 * @returns {Array<{day:string, peak:number}>}
 */
function getDailyPeaks(game, serverId, days = 7, nowMs = g.nowMs()) {
  const keys = g.lastNDayKeys(days, nowMs);
  const byDay = Object.create(null);
  for (const k of keys) byDay[k] = 0;

  const arr = gameSnaps(statsStore.load(), game);
  for (const e of arr) {
    const v = e.p[serverId];
    if (v == null) continue;
    const key = g.localDayKey(e.t);
    if (key in byDay && v > byDay[key]) byDay[key] = v;
  }
  return keys.map((day) => ({ day, peak: byDay[day] }));
}

/**
 * Last `points` recorded values for a server (chronological), for a sparkline.
 * Missing values within the window are treated as 0.
 */
function getSparkline(game, serverId, points = 24) {
  const arr = gameSnaps(statsStore.load(), game);
  const tail = arr.slice(-points);
  return tail.map((e) => {
    const v = e.p[serverId];
    return v == null ? 0 : v;
  });
}

/**
 * Raw samples for a set of servers in [fromMs, toMs), for the analytics layer's
 * Postgres-down fallback. Offline polls come back as `on:false, v:0`.
 * @returns {Object<string, Array<{t:number, v:number, on:boolean}>>} keyed by server id
 */
function readSeries(game, serverIds, fromMs, toMs = g.nowMs()) {
  const want = new Set(serverIds);
  const out = {};
  for (const id of want) out[id] = [];
  const arr = gameSnaps(statsStore.load(), game);
  for (const e of arr) {
    if (e.t < fromMs || e.t >= toMs) continue;
    for (const id of want) {
      const v = e.p ? e.p[id] : undefined;
      if (v != null && v >= 0) out[id].push({ t: e.t, v, on: true });
      else if (e.d && e.d.indexOf(id) !== -1) out[id].push({ t: e.t, v: 0, on: false });
    }
  }
  return out;
}

/** Oldest sample timestamp held in the file cache (or null when empty). */
function earliestSampleMs() {
  let min = null;
  const data = statsStore.load();
  for (const arr of Object.values(data.snapshots || {})) {
    if (arr.length && (min == null || arr[0].t < min)) min = arr[0].t;
  }
  return min;
}

/** Sum of latest counts across a game's servers (for the "total" view). */
function getGameTotalLatest(game, serverIds) {
  let total = 0;
  for (const id of serverIds) {
    const l = getLatest(game, id);
    if (l) total += l.players;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Guild welcome config (file cache / DB-down fallback)
// ---------------------------------------------------------------------------

function defaultGuildConfig() {
  return {
    dm: null, // message JSON { content, imageUrl?, embeds? } or null (disabled)
    channel: null, // message JSON or null (disabled)
    welcomeChannelId: null,
    autoRoles: [],
    logChannelId: null,
    card: null, // welcome card (layered image) document or null
  };
}

function hasGuildConfigFile(guildId) {
  const data = guildStore.load();
  return !!(data.guilds && Object.prototype.hasOwnProperty.call(data.guilds, guildId));
}

function getGuildConfigFile(guildId) {
  const data = guildStore.load();
  const cfg = data.guilds && data.guilds[guildId];
  return { ...defaultGuildConfig(), ...(cfg || {}) };
}

function setGuildConfigFile(guildId, cfg) {
  const data = guildStore.load();
  if (!data.guilds) data.guilds = {};
  data.guilds[guildId] = { ...defaultGuildConfig(), ...(data.guilds[guildId] || {}), ...cfg };
  guildStore.save(data);
  return data.guilds[guildId];
}

function getAllGuildConfigsFile() {
  const data = guildStore.load();
  return data.guilds || {};
}

// ---------------------------------------------------------------------------
// Server metadata mirror (names/addresses discovered from the live APIs)
//
// Written every poll, so it is throttled: only a material change (name,
// address, capacity) or a stale `lastSeen` triggers a disk write.
// ---------------------------------------------------------------------------

const META_TOUCH_MS = 5 * 60 * 1000;

function upsertServerMetaFile(entries, tsMs = g.nowMs()) {
  const data = metaStore.load();
  if (!data.servers) data.servers = {};
  let dirty = false;
  for (const e of entries || []) {
    if (!e || !e.game || e.id == null) continue;
    const key = `${e.game}:${e.id}`;
    const cur = data.servers[key] || { firstSeen: tsMs };
    const max = Number(e.maxplayers);
    const next = {
      firstSeen: cur.firstSeen || tsMs,
      name: e.name || cur.name || null,
      address: e.address || cur.address || null,
      maxSlots: Math.max(Number.isFinite(max) && max > 0 ? Math.round(max) : 0, cur.maxSlots || 0) || null,
      lastSeen: tsMs,
    };
    if (
      !data.servers[key] ||
      next.name !== cur.name ||
      next.address !== cur.address ||
      next.maxSlots !== cur.maxSlots ||
      tsMs - (cur.lastSeen || 0) > META_TOUCH_MS
    ) {
      dirty = true;
    }
    data.servers[key] = next;
  }
  if (dirty) metaStore.save(data);
  return dirty;
}

function getServerMetaFile() {
  return metaStore.load().servers || {};
}

// ---------------------------------------------------------------------------
// Admin / introspection
// ---------------------------------------------------------------------------

function getFileStats() {
  const data = statsStore.load();
  const counts = {};
  let totalEntries = 0;
  for (const [game, arr] of Object.entries(data.snapshots || {})) {
    counts[game] = arr.length;
    totalEntries += arr.length;
  }
  const guilds = getAllGuildConfigsFile();
  return {
    statsPath: STATS_PATH,
    statsBytes: statsStore.bytes(),
    snapshotCounts: counts,
    totalEntries,
    retentionDays: RETENTION_MS / g.DAY_MS,
    guildConfigBytes: guildStore.bytes(),
    guildCount: Object.keys(guilds).length,
  };
}

module.exports = {
  RETENTION_MS,
  // snapshots
  recordSnapshot,
  getLatest,
  getTodayPeak,
  get24hPeak,
  getDailyPeaks,
  getSparkline,
  getGameTotalLatest,
  readSeries,
  earliestSampleMs,
  // server metadata
  upsertServerMetaFile,
  getServerMetaFile,
  // guild config
  defaultGuildConfig,
  hasGuildConfigFile,
  getGuildConfigFile,
  setGuildConfigFile,
  getAllGuildConfigsFile,
  // admin
  getFileStats,
  // exposed for tests/admin
  _paths: { STATS_PATH, GUILD_PATH },
};
