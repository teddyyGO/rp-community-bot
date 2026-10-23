'use strict';

/**
 * Postgres layer: long-term snapshot storage (90-day retention) + per-guild
 * welcome config. Every analytic read falls back to stats.js (stats.json) when
 * the DB is unreachable, so the bot keeps working with Postgres down.
 *
 * Guild config is write-through: every set persists to the local file first
 * (so it survives a DB outage / restart) and then mirrors to Postgres.
 */

const { Pool } = require('pg');
const stats = require('./stats');
const g = require('./gtime');

const HAS_DB = !!process.env.DATABASE_URL;

let pool = null;
let dbUp = false;
let lastError = null;

function sslConfig() {
  const url = process.env.DATABASE_URL || '';
  if (/PGSSL(MODE)?=disable/i.test(url) || /sslmode=disable/i.test(url)) return false;
  // Local Postgres typically has no SSL; Railway's needs SSL with a self-signed cert.
  if (/@(localhost|127\.0\.0\.1)/i.test(url)) return false;
  return { rejectUnauthorized: false };
}

function isEnabled() {
  return HAS_DB;
}
function isUp() {
  return dbUp;
}
function getLastError() {
  return lastError;
}

async function q(text, params, _retried = false) {
  if (!pool) throw new Error('postgres not configured');
  try {
    const r = await pool.query(text, params);
    dbUp = true;
    return r;
  } catch (e) {
    // Tables missing (e.g. Postgres was unreachable at boot so ensureSchema
    // never ran, then later recovered). Create the schema lazily and retry once.
    if (e.code === '42P01' && !_retried) {
      try {
        await ensureSchema();
      } catch {
        /* fall through to the error path below */
      }
      return q(text, params, true);
    }
    dbUp = false;
    lastError = e.message;
    throw e;
  }
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id        BIGSERIAL PRIMARY KEY,
      game      TEXT NOT NULL,
      server_id TEXT NOT NULL,
      players   INTEGER NOT NULL,
      ts        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_snapshots_game_server_ts ON snapshots (game, server_id, ts)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots (ts)`);
  // Analytics columns, added in place for existing installs. `online` lets a
  // downtime be distinguished from a gap in sampling (uptime %); `maxplayers`
  // gives capacity / fill-rate. Adding a NOT NULL column with a constant
  // default does not rewrite the table on PG 11+.
  await pool.query(`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS online BOOLEAN NOT NULL DEFAULT true`);
  await pool.query(`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS maxplayers INTEGER`);

  // Hourly rollup. Raw snapshots are pruned at 90 days, but this survives, so
  // all-time records and long-range trends stay available; it also keeps
  // 30/90-day queries cheap (one row per server-hour instead of 60).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_hourly (
      game           TEXT NOT NULL,
      server_id      TEXT NOT NULL,
      hour_start     TIMESTAMPTZ NOT NULL,
      peak           INTEGER,
      low            INTEGER,
      sum_players    BIGINT NOT NULL DEFAULT 0,
      samples        INTEGER NOT NULL DEFAULT 0,
      online_samples INTEGER NOT NULL DEFAULT 0,
      max_slots      INTEGER,
      PRIMARY KEY (game, server_id, hour_start)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_hourly_hour ON server_hourly (hour_start)`);

  // Names/addresses discovered from the live APIs, so the panel can show
  // "Wild West RP" instead of the raw cfx code.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_meta (
      game       TEXT NOT NULL,
      server_id  TEXT NOT NULL,
      name       TEXT,
      address    TEXT,
      max_slots  INTEGER,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen  TIMESTAMPTZ,
      PRIMARY KEY (game, server_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id           TEXT PRIMARY KEY,
      dm                 JSONB,
      channel            JSONB,
      welcome_channel_id TEXT,
      auto_roles         TEXT[] NOT NULL DEFAULT '{}',
      log_channel_id     TEXT,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Welcome card (layered image) document, added in place for existing tables.
  await pool.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS card JSONB`);
  // Uploaded image assets for welcome cards (durable across ephemeral FS).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS welcome_assets (
      id         TEXT PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      mime       TEXT NOT NULL,
      bytes      BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function init() {
  if (!HAS_DB) {
    dbUp = false;
    return false;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslConfig(),
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
  });
  // A pool-level error (e.g. server dropped) must never crash the process.
  pool.on('error', (err) => {
    dbUp = false;
    lastError = err.message;
  });
  try {
    await ensureSchema();
    dbUp = true;
    return true;
  } catch (e) {
    dbUp = false;
    lastError = e.message;
    return false;
  }
}

async function end() {
  if (pool) {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    pool = null;
  }
}

// ---------------------------------------------------------------------------
// Snapshots (best-effort write; reads fall back to stats.js)
// ---------------------------------------------------------------------------

/**
 * @param {string} game
 * @param {Array<{id:string,players:number,online?:boolean,maxplayers?:number}>} samples
 * @param {number} tsMs
 */
async function recordSnapshot(game, samples, tsMs = g.nowMs()) {
  if (!HAS_DB || !pool) return false;
  const rows = samples.filter((s) => s && s.id != null && Number.isFinite(s.players) && s.players >= 0);
  if (!rows.length) return false;
  const iso = new Date(tsMs).toISOString();
  const values = [];
  const tuples = rows.map((s, i) => {
    const b = i * 6;
    const max = Number(s.maxplayers);
    values.push(game, String(s.id), Math.round(s.players), iso, s.online !== false, Number.isFinite(max) && max > 0 ? Math.round(max) : null);
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
  });
  try {
    await q(
      `INSERT INTO snapshots (game, server_id, players, ts, online, maxplayers) VALUES ${tuples.join(',')}`,
      values
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort escape hatch for the analytics layer: runs a read query and
 * resolves to `null` (never throws) when Postgres is disabled or unreachable,
 * so callers can transparently fall back to the stats.json computations.
 */
async function sql(text, params) {
  if (!HAS_DB || !pool) return null;
  try {
    return await q(text, params);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server metadata (names discovered from the live APIs) + hourly rollups
// ---------------------------------------------------------------------------

/** @param {Array<{game,id,name?,address?,maxplayers?}>} entries */
async function upsertServerMeta(entries, tsMs = g.nowMs()) {
  const rows = (entries || []).filter((e) => e && e.game && e.id != null);
  if (!rows.length) return false;
  stats.upsertServerMetaFile(rows, tsMs); // local mirror, works with the DB down
  if (!HAS_DB || !pool) return false;
  const iso = new Date(tsMs).toISOString();
  const values = [];
  const tuples = rows.map((e, i) => {
    const b = i * 6;
    const max = Number(e.maxplayers);
    values.push(e.game, String(e.id), e.name || null, e.address || null, Number.isFinite(max) && max > 0 ? Math.round(max) : null, iso);
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
  });
  try {
    await q(
      `INSERT INTO server_meta (game, server_id, name, address, max_slots, last_seen)
       VALUES ${tuples.join(',')}
       ON CONFLICT (game, server_id) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, server_meta.name),
         address = COALESCE(EXCLUDED.address, server_meta.address),
         max_slots = GREATEST(COALESCE(EXCLUDED.max_slots, 0), COALESCE(server_meta.max_slots, 0)),
         last_seen = EXCLUDED.last_seen`,
      values
    );
    return true;
  } catch {
    return false;
  }
}

/** @returns {Promise<Object<string, {name,address,maxSlots,firstSeen,lastSeen}>>} keyed `game:id` */
async function getServerMeta() {
  const local = stats.getServerMetaFile();
  const r = await sql(`SELECT game, server_id, name, address, max_slots, first_seen, last_seen FROM server_meta`);
  if (!r) return local;
  const out = {};
  for (const row of r.rows) {
    out[`${row.game}:${row.server_id}`] = {
      name: row.name || null,
      address: row.address || null,
      maxSlots: row.max_slots || null,
      firstSeen: row.first_seen ? new Date(row.first_seen).getTime() : null,
      lastSeen: row.last_seen ? new Date(row.last_seen).getTime() : null,
    };
  }
  // Anything the local mirror knows but the DB has not seen yet still counts.
  for (const [k, v] of Object.entries(local)) {
    out[k] = { ...v, ...(out[k] || {}), name: (out[k] && out[k].name) || v.name };
  }
  return out;
}

/**
 * Fold raw snapshots into `server_hourly` for every hour touched since
 * `sinceMs`. Idempotent (recomputes whole hours), so re-running is safe and a
 * partially-filled current hour is corrected on the next pass.
 */
async function rollupHourly(sinceMs = g.nowMs() - 3 * 60 * 60 * 1000) {
  const r = await sql(
    `INSERT INTO server_hourly (game, server_id, hour_start, peak, low, sum_players, samples, online_samples, max_slots)
     SELECT game, server_id, date_trunc('hour', ts) AS hour_start,
            MAX(players) FILTER (WHERE online),
            MIN(players) FILTER (WHERE online),
            COALESCE(SUM(players) FILTER (WHERE online), 0),
            COUNT(*),
            COUNT(*) FILTER (WHERE online),
            MAX(maxplayers)
     FROM snapshots
     WHERE ts >= $1
     GROUP BY 1, 2, 3
     ON CONFLICT (game, server_id, hour_start) DO UPDATE SET
       peak = EXCLUDED.peak, low = EXCLUDED.low, sum_players = EXCLUDED.sum_players,
       samples = EXCLUDED.samples, online_samples = EXCLUDED.online_samples,
       max_slots = GREATEST(COALESCE(EXCLUDED.max_slots, 0), COALESCE(server_hourly.max_slots, 0))`,
    [new Date(sinceMs).toISOString()]
  );

  // Aggregate rows (`<game>:@total` and `@all:@total`). These are stored rather
  // than derived because a total's peak is the max of the *summed* curve, which
  // cannot be recovered from per-server peaks (summing those overstates it).
  // Every server of a game is sampled with the same tick timestamp, so grouping
  // by `ts` reconstructs the concurrent total exactly.
  const agg = await sql(
    `INSERT INTO server_hourly (game, server_id, hour_start, peak, low, sum_players, samples, online_samples, max_slots)
     WITH per_ts AS (
       SELECT game, ts, date_trunc('hour', ts) AS h,
              COALESCE(SUM(players) FILTER (WHERE online), 0) AS tot,
              COUNT(*) FILTER (WHERE online) AS non
       FROM snapshots WHERE ts >= $1 GROUP BY 1, 2, 3
     ), by_game AS (
       SELECT game, h, MAX(tot) AS peak, MIN(tot) AS low, SUM(tot) AS sum_players,
              COUNT(*) AS samples, COUNT(*) FILTER (WHERE non > 0) AS online_samples
       FROM per_ts GROUP BY 1, 2
     ), all_ts AS (
       SELECT ts, h, SUM(tot) AS tot, SUM(non) AS non FROM per_ts GROUP BY 1, 2
     ), by_all AS (
       SELECT '@all'::text AS game, h, MAX(tot) AS peak, MIN(tot) AS low, SUM(tot) AS sum_players,
              COUNT(*) AS samples, COUNT(*) FILTER (WHERE non > 0) AS online_samples
       FROM all_ts GROUP BY 1, 2
     )
     SELECT game, '@total', h, peak::int, low::int, sum_players::bigint,
            samples::int, online_samples::int, NULL::int FROM by_game
     UNION ALL
     SELECT game, '@total', h, peak::int, low::int, sum_players::bigint,
            samples::int, online_samples::int, NULL::int FROM by_all
     ON CONFLICT (game, server_id, hour_start) DO UPDATE SET
       peak = EXCLUDED.peak, low = EXCLUDED.low, sum_players = EXCLUDED.sum_players,
       samples = EXCLUDED.samples, online_samples = EXCLUDED.online_samples`,
    [new Date(sinceMs).toISOString()]
  );
  return (r ? r.rowCount || 0 : 0) + (agg ? agg.rowCount || 0 : 0);
}

/** Backfill the rollup table from whatever raw history exists (first boot). */
async function backfillHourly() {
  const r = await sql(`SELECT count(*)::bigint AS c FROM server_hourly`);
  if (!r || Number(r.rows[0].c) > 0) return 0;
  return rollupHourly(0);
}

async function getTodayPeak(game, serverId, nowMs = g.nowMs()) {
  if (HAS_DB && pool) {
    try {
      const start = new Date(g.localDayStart(nowMs)).toISOString();
      const r = await q(
        `SELECT COALESCE(MAX(players),0) AS peak FROM snapshots WHERE game=$1 AND server_id=$2 AND ts >= $3`,
        [game, serverId, start]
      );
      return Number(r.rows[0].peak) || 0;
    } catch {
      /* fall through */
    }
  }
  return stats.getTodayPeak(game, serverId, nowMs);
}

async function get24hPeak(game, serverId, nowMs = g.nowMs()) {
  if (HAS_DB && pool) {
    try {
      const since = new Date(nowMs - g.DAY_MS).toISOString();
      const r = await q(
        `SELECT COALESCE(MAX(players),0) AS peak FROM snapshots WHERE game=$1 AND server_id=$2 AND ts >= $3`,
        [game, serverId, since]
      );
      return Number(r.rows[0].peak) || 0;
    } catch {
      /* fall through */
    }
  }
  return stats.get24hPeak(game, serverId, nowMs);
}

/** @returns {Promise<Array<{day:string, peak:number}>>} */
async function getDailyPeaks(game, serverId, days = 7, nowMs = g.nowMs()) {
  if (HAS_DB && pool) {
    try {
      const since = new Date(g.localDayStart(nowMs) - (days - 1) * g.DAY_MS).toISOString();
      const r = await q(
        `SELECT to_char(date_trunc('day', (ts AT TIME ZONE $4::interval) - interval '6 hours'), 'YYYY-MM-DD') AS day,
                MAX(players) AS peak
         FROM snapshots
         WHERE game=$1 AND server_id=$2 AND ts >= $3
         GROUP BY 1`,
        [game, serverId, since, g.PG_OFFSET]
      );
      const map = Object.create(null);
      for (const row of r.rows) map[row.day] = Number(row.peak) || 0;
      return g.lastNDayKeys(days, nowMs).map((day) => ({ day, peak: map[day] || 0 }));
    } catch {
      /* fall through */
    }
  }
  return stats.getDailyPeaks(game, serverId, days, nowMs);
}

// ---------------------------------------------------------------------------
// Guild welcome config
//
// The local file is AUTHORITATIVE on read: it is written through on every
// change, is fast (no network round-trip), and survives a Postgres outage.
// Postgres is a durable mirror used to restore the file after a cold start
// (Railway's filesystem is ephemeral). Writes that fail against Postgres are
// queued and re-pushed once the DB is reachable again, so a write made during
// an outage is never silently lost or clobbered by a later stale DB read.
// ---------------------------------------------------------------------------

const dirtyGuilds = new Set();

function rowToConfig(row) {
  return {
    dm: row.dm || null,
    channel: row.channel || null,
    welcomeChannelId: row.welcome_channel_id || null,
    autoRoles: row.auto_roles || [],
    logChannelId: row.log_channel_id || null,
    card: row.card || null,
  };
}

async function pushGuildToDb(guildId, cfg) {
  await q(
    `INSERT INTO guild_config (guild_id, dm, channel, welcome_channel_id, auto_roles, log_channel_id, card, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (guild_id) DO UPDATE SET
       dm = EXCLUDED.dm,
       channel = EXCLUDED.channel,
       welcome_channel_id = EXCLUDED.welcome_channel_id,
       auto_roles = EXCLUDED.auto_roles,
       log_channel_id = EXCLUDED.log_channel_id,
       card = EXCLUDED.card,
       updated_at = now()`,
    [guildId, cfg.dm, cfg.channel, cfg.welcomeChannelId, cfg.autoRoles, cfg.logChannelId, cfg.card]
  );
}

async function flushDirty() {
  if (!HAS_DB || !pool || !dirtyGuilds.size) return;
  for (const gid of [...dirtyGuilds]) {
    try {
      await pushGuildToDb(gid, stats.getGuildConfigFile(gid));
      dirtyGuilds.delete(gid);
    } catch {
      break; // DB still unreachable; retry on a later call
    }
  }
}

async function getGuildConfig(guildId) {
  // File is authoritative when it already holds this guild.
  if (stats.hasGuildConfigFile(guildId)) {
    if (HAS_DB && pool && dirtyGuilds.size) flushDirty().catch(() => {});
    return stats.getGuildConfigFile(guildId);
  }
  // Cold start (file wiped by ephemeral FS): restore from Postgres if possible.
  if (HAS_DB && pool) {
    try {
      const r = await q(
        `SELECT dm, channel, welcome_channel_id, auto_roles, log_channel_id, card FROM guild_config WHERE guild_id=$1`,
        [guildId]
      );
      if (r.rows.length) {
        const cfg = rowToConfig(r.rows[0]);
        stats.setGuildConfigFile(guildId, cfg); // restore local cache
        return cfg;
      }
    } catch {
      /* fall through to default */
    }
  }
  return stats.getGuildConfigFile(guildId);
}

async function setGuildConfig(guildId, patch) {
  // Persist locally first so the change is never lost if the DB write fails.
  const merged = stats.setGuildConfigFile(guildId, patch);
  if (HAS_DB && pool) {
    try {
      await pushGuildToDb(guildId, merged);
      dirtyGuilds.delete(guildId);
      await flushDirty(); // opportunistically re-push anything queued
    } catch {
      dirtyGuilds.add(guildId); // re-push once the DB is reachable again
    }
  }
  return merged;
}

async function getAllGuildConfigs() {
  if (HAS_DB && pool) {
    try {
      const r = await q(
        `SELECT guild_id, dm, channel, welcome_channel_id, auto_roles, log_channel_id, card FROM guild_config`
      );
      const out = {};
      for (const row of r.rows) out[row.guild_id] = rowToConfig(row);
      // The local file is authoritative, so let it override (and add) entries.
      for (const [gid, cfg] of Object.entries(stats.getAllGuildConfigsFile())) {
        out[gid] = cfg;
      }
      return out;
    } catch {
      /* fall through */
    }
  }
  return stats.getAllGuildConfigsFile();
}

// ---------------------------------------------------------------------------
// Welcome card image assets (DB-backed, with a small in-memory LRU cache so
// renders work during brief DB outages and don't re-fetch hot images)
// ---------------------------------------------------------------------------

const assetCache = new Map(); // id -> { mime, bytes: Buffer }
const ASSET_CACHE_MAX = 24;

function touchAsset(id, val) {
  assetCache.delete(id);
  assetCache.set(id, val);
  while (assetCache.size > ASSET_CACHE_MAX) {
    assetCache.delete(assetCache.keys().next().value);
  }
}

async function saveAsset(guildId, id, mime, buffer) {
  touchAsset(id, { mime, bytes: buffer });
  if (HAS_DB && pool) {
    try {
      await q(
        `INSERT INTO welcome_assets (id, guild_id, mime, bytes) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes`,
        [id, guildId, mime, buffer]
      );
    } catch {
      /* held in memory at least for this instance */
    }
  }
  return id;
}

async function getAsset(id) {
  if (assetCache.has(id)) {
    const v = assetCache.get(id);
    touchAsset(id, v);
    return v;
  }
  if (HAS_DB && pool) {
    try {
      const r = await q(`SELECT mime, bytes FROM welcome_assets WHERE id=$1`, [id]);
      if (r.rows.length) {
        const v = { mime: r.rows[0].mime, bytes: r.rows[0].bytes };
        touchAsset(id, v);
        return v;
      }
    } catch {
      /* unavailable */
    }
  }
  return null;
}

async function deleteAsset(id) {
  assetCache.delete(id);
  if (HAS_DB && pool) {
    try {
      await q(`DELETE FROM welcome_assets WHERE id=$1`, [id]);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Maintenance / admin
// ---------------------------------------------------------------------------

async function cleanup(retentionDays = 90, hourlyRetentionDays = 1095) {
  if (!HAS_DB || !pool) return 0;
  let removed = 0;
  try {
    // Roll the window up before deleting it, so pruned detail is never lost.
    await rollupHourly(Date.now() - (retentionDays + 1) * g.DAY_MS);
    const r = await q(`DELETE FROM snapshots WHERE ts < now() - make_interval(days => $1::int)`, [retentionDays]);
    removed += r.rowCount || 0;
  } catch {
    /* ignore */
  }
  try {
    const r = await q(`DELETE FROM server_hourly WHERE hour_start < now() - make_interval(days => $1::int)`, [
      hourlyRetentionDays,
    ]);
    removed += r.rowCount || 0;
  } catch {
    /* ignore */
  }
  return removed;
}

async function getDbState() {
  const state = { enabled: HAS_DB, up: dbUp, lastError };
  if (HAS_DB && pool) {
    try {
      const r = await q(`SELECT now() AS now`);
      state.up = true;
      state.now = r.rows[0].now;
    } catch (e) {
      state.up = false;
      state.lastError = e.message;
    }
  }
  return state;
}

async function getTableSizes() {
  if (!HAS_DB || !pool) return [];
  try {
    const r = await q(`
      SELECT relname AS name, n_live_tup AS rows, pg_total_relation_size(relid) AS bytes
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
    `);
    return r.rows.map((x) => ({ name: x.name, rows: Number(x.rows), bytes: Number(x.bytes) }));
  } catch {
    return [];
  }
}

async function getSnapshotCount() {
  if (!HAS_DB || !pool) return null;
  try {
    const r = await q(`SELECT count(*)::bigint AS c FROM snapshots`);
    return Number(r.rows[0].c);
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  isUp,
  getLastError,
  init,
  end,
  // snapshots
  recordSnapshot,
  getTodayPeak,
  get24hPeak,
  getDailyPeaks,
  // analytics support
  sql,
  upsertServerMeta,
  getServerMeta,
  rollupHourly,
  backfillHourly,
  // guild config
  getGuildConfig,
  setGuildConfig,
  getAllGuildConfigs,
  // welcome card assets
  saveAsset,
  getAsset,
  deleteAsset,
  // maintenance / admin
  cleanup,
  getDbState,
  getTableSizes,
  getSnapshotCount,
};
