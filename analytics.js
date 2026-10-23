'use strict';

/**
 * Analytics layer for the web panel.
 *
 * Everything the stats panel shows is computed here so the HTTP layer stays a
 * thin JSON shim. Two storage tiers back it:
 *
 *   raw `snapshots`     one row per server per minute, pruned at 90 days.
 *                       Used whenever the requested bucket is under an hour.
 *   `server_hourly`     one row per server-hour, kept for years. Used for long
 *                       ranges and for every all-time record, so history
 *                       outlives the raw prune.
 *
 * With Postgres unavailable every query degrades to the same computation over
 * stats.json (~8 days of minute samples) instead of failing.
 *
 * A "key" identifies a series: `<game>:<serverId>`, plus two aggregate forms —
 * `<game>:@total` (all servers of one game) and `@all:@total` (everything).
 * Aggregate peaks are the max of the *summed* curve, never a sum of peaks.
 *
 * All calendar math uses local community time (UTC_OFFSET_HOURS) with a day that runs DAY_START_HOUR→DAY_START_HOUR (06:00 by default).
 */

const db = require('./db');
const stats = require('./stats');
const g = require('./gtime');

const HOUR_MS = 60 * 60 * 1000;
const SAMPLE_MS = 60 * 1000; // nominal sampling interval (1/min/game)
const TOTAL_ID = '@total';
const ALL_GAME = '@all';

// Bucket sizes offered to the auto-picker, coarsest-last.
const BUCKETS = [
  60, 2 * 60, 5 * 60, 10 * 60, 15 * 60, 30 * 60,
  3600, 2 * 3600, 3 * 3600, 6 * 3600, 12 * 3600, 24 * 3600,
].map((s) => s * 1000);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Postgres parameter accumulator: `p.add(v)` returns the `$n` placeholder. */
function params() {
  const v = [];
  return {
    v,
    add(x) {
      v.push(x);
      return `$${v.length}`;
    },
  };
}

function parseKey(key) {
  const s = String(key || '');
  const i = s.indexOf(':');
  if (i < 0) return null;
  const game = s.slice(0, i);
  const id = s.slice(i + 1);
  if (!game || !id) return null;
  return { key: s, game, id, aggregate: id === TOTAL_ID, all: game === ALL_GAME };
}

function parseKeys(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const k = parseKey(String(raw).trim());
    if (k && !seen.has(k.key)) {
      seen.add(k.key);
      out.push(k);
    }
  }
  return out.slice(0, 40); // hard cap: one request can never fan out unbounded
}

function pickBucket(spanMs, targetPoints = 320) {
  const ideal = spanMs / Math.max(20, targetPoints);
  for (const b of BUCKETS) if (b >= ideal) return b;
  return BUCKETS[BUCKETS.length - 1];
}

function round(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/** `(game, server_id) IN ((..),(..))` for a set of non-aggregate keys. */
function tupleFilter(keys, p) {
  const tuples = keys.map((k) => `(${p.add(k.game)}, ${p.add(k.id)})`);
  return `(game, server_id) IN (${tuples.join(', ')})`;
}

// A tiny TTL memo. The panel polls, and several widgets share the same
// underlying range, so identical queries within a few seconds are common.
const memo = new Map();
const MEMO_MAX = 120;

async function cached(name, args, ttlMs, fn) {
  const key = `${name}|${JSON.stringify(args)}`;
  const hit = memo.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.val;
  const val = await fn();
  memo.set(key, { at: now, val });
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  return val;
}

function invalidate() {
  memo.clear();
}

// ---------------------------------------------------------------------------
// Bucketing over in-memory samples (the Postgres-down path)
// ---------------------------------------------------------------------------

/**
 * @param {Array<{t:number,v:number,on:boolean}>} pts
 * @returns {Array<{t,peak,avg,low,n,on}>} one entry per non-empty bucket
 */
function bucketize(pts, fromMs, toMs, bucketMs) {
  const by = new Map();
  for (const pt of pts) {
    if (pt.t < fromMs || pt.t >= toMs) continue;
    const b = Math.floor(pt.t / bucketMs) * bucketMs;
    let e = by.get(b);
    if (!e) {
      e = { t: b, peak: null, low: null, sum: 0, n: 0, on: 0 };
      by.set(b, e);
    }
    e.n++;
    if (pt.on) {
      e.on++;
      e.sum += pt.v;
      if (e.peak == null || pt.v > e.peak) e.peak = pt.v;
      if (e.low == null || pt.v < e.low) e.low = pt.v;
    }
  }
  return [...by.values()]
    .sort((a, b) => a.t - b.t)
    .map((e) => ({
      t: e.t,
      peak: e.peak,
      low: e.low,
      avg: e.on ? round(e.sum / e.on, 2) : null,
      n: e.n,
      on: e.on,
    }));
}

/** Sum several per-server sample lists into one concurrent-total list. */
function sumSeries(lists) {
  const by = new Map();
  for (const pts of lists) {
    for (const pt of pts) {
      let e = by.get(pt.t);
      if (!e) {
        e = { t: pt.t, v: 0, on: false };
        by.set(pt.t, e);
      }
      if (pt.on) {
        e.v += pt.v;
        e.on = true;
      }
    }
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

/** Configured servers, grouped per game — the universe for aggregate keys. */
let configRef = () => ({ servers: {} });
function setConfigProvider(fn) {
  configRef = fn;
}

function configuredServers() {
  const cfg = configRef() || { servers: {} };
  const out = [];
  for (const [game, list] of Object.entries(cfg.servers || {})) {
    for (const s of list || []) out.push({ game, id: s.id, name: s.name, host: s.host, port: s.port, code: s.code });
  }
  return out;
}

/** Resolve an aggregate key to the concrete servers it covers (file path only). */
function membersOf(k) {
  const all = configuredServers();
  if (k.all) return all;
  if (k.aggregate) return all.filter((s) => s.game === k.game);
  return all.filter((s) => s.game === k.game && s.id === k.id);
}

function fileSeries(k, fromMs, toMs) {
  const mem = membersOf(k);
  if (!mem.length) return [];
  const byGame = new Map();
  for (const s of mem) {
    if (!byGame.has(s.game)) byGame.set(s.game, []);
    byGame.get(s.game).push(s.id);
  }
  const lists = [];
  for (const [game, ids] of byGame) {
    const read = stats.readSeries(game, ids, fromMs, toMs);
    for (const id of ids) lists.push(read[id] || []);
  }
  return k.aggregate ? sumSeries(lists) : lists[0] || [];
}

// ---------------------------------------------------------------------------
// series() — bucketed time series for one or more keys
// ---------------------------------------------------------------------------

async function seriesDb(keys, fromMs, toMs, bucketMs) {
  const out = {};
  const plain = keys.filter((k) => !k.aggregate);
  const aggs = keys.filter((k) => k.aggregate);
  const useHourly = bucketMs >= HOUR_MS;
  const secs = bucketMs / 1000;

  if (useHourly) {
    // Aggregates live in the rollup as ordinary rows, so one query covers all.
    if (!keys.length) return out;
    const p = params();
    const from = p.add(iso(fromMs));
    const to = p.add(iso(toMs));
    const filter = tupleFilter(keys, p);
    const b = p.add(secs);
    const r = await db.sql(
      `SELECT game, server_id,
              (floor(extract(epoch FROM hour_start) / ${b}) * ${b})::bigint AS bucket,
              MAX(peak) AS peak, MIN(low) AS low,
              SUM(sum_players)::float / NULLIF(SUM(online_samples), 0) AS avg,
              SUM(samples)::int AS n, SUM(online_samples)::int AS non
       FROM server_hourly
       WHERE hour_start >= ${from} AND hour_start < ${to} AND ${filter}
       GROUP BY 1, 2, 3 ORDER BY 3`,
      p.v
    );
    if (!r) return null;
    // An empty rollup (fresh install / backfill pending) falls through to raw.
    if (r.rows.length) {
      for (const k of keys) out[k.key] = [];
      for (const row of r.rows) {
        const key = `${row.game}:${row.server_id}`;
        if (!out[key]) out[key] = [];
        out[key].push({
          t: Number(row.bucket) * 1000,
          peak: row.peak == null ? null : Number(row.peak),
          low: row.low == null ? null : Number(row.low),
          avg: round(row.avg, 2),
          n: Number(row.n) || 0,
          on: Number(row.non) || 0,
        });
      }
      return out;
    }
  }

  if (plain.length) {
    const p = params();
    const from = p.add(iso(fromMs));
    const to = p.add(iso(toMs));
    const filter = tupleFilter(plain, p);
    const b = p.add(secs);
    const r = await db.sql(
      `SELECT game, server_id,
              (floor(extract(epoch FROM ts) / ${b}) * ${b})::bigint AS bucket,
              MAX(players) FILTER (WHERE online) AS peak,
              MIN(players) FILTER (WHERE online) AS low,
              AVG(players::float) FILTER (WHERE online) AS avg,
              COUNT(*)::int AS n, COUNT(*) FILTER (WHERE online)::int AS non
       FROM snapshots
       WHERE ts >= ${from} AND ts < ${to} AND ${filter}
       GROUP BY 1, 2, 3 ORDER BY 3`,
      p.v
    );
    if (!r) return null;
    for (const k of plain) out[k.key] = [];
    for (const row of r.rows) {
      const key = `${row.game}:${row.server_id}`;
      if (!out[key]) out[key] = [];
      out[key].push({
        t: Number(row.bucket) * 1000,
        peak: row.peak == null ? null : Number(row.peak),
        low: row.low == null ? null : Number(row.low),
        avg: round(row.avg, 2),
        n: Number(row.n) || 0,
        on: Number(row.non) || 0,
      });
    }
  }

  for (const k of aggs) {
    const p = params();
    const from = p.add(iso(fromMs));
    const to = p.add(iso(toMs));
    const gameFilter = k.all ? '' : ` AND game = ${p.add(k.game)}`;
    const b = p.add(secs);
    const r = await db.sql(
      `WITH per_ts AS (
         SELECT ts, COALESCE(SUM(players) FILTER (WHERE online), 0) AS tot,
                COUNT(*) FILTER (WHERE online) AS non
         FROM snapshots
         WHERE ts >= ${from} AND ts < ${to}${gameFilter}
         GROUP BY ts
       )
       SELECT (floor(extract(epoch FROM ts) / ${b}) * ${b})::bigint AS bucket,
              MAX(tot) AS peak, MIN(tot) AS low, AVG(tot::float) AS avg,
              COUNT(*)::int AS n, COUNT(*) FILTER (WHERE non > 0)::int AS non
       FROM per_ts GROUP BY 1 ORDER BY 1`,
      p.v
    );
    if (!r) return null;
    out[k.key] = r.rows.map((row) => ({
      t: Number(row.bucket) * 1000,
      peak: row.peak == null ? null : Number(row.peak),
      low: row.low == null ? null : Number(row.low),
      avg: round(row.avg, 2),
      n: Number(row.n) || 0,
      on: Number(row.non) || 0,
    }));
  }
  return out;
}

/**
 * @param {{keys:string[]|string, from?:number, to?:number, points?:number, bucketMs?:number}} opts
 */
async function series(opts) {
  const keys = parseKeys(opts.keys);
  const to = Math.min(opts.to || Date.now(), Date.now());
  const from = Math.max(0, opts.from || to - 24 * g.DAY_MS);
  const bucketMs = opts.bucketMs || pickBucket(to - from, opts.points || 320);
  if (!keys.length) return { from, to, bucketMs, source: 'none', series: {} };

  return cached('series', { k: keys.map((k) => k.key), from, to, bucketMs }, 20_000, async () => {
    const dbOut = await seriesDb(keys, from, to, bucketMs);
    if (dbOut) {
      return { from, to, bucketMs, source: bucketMs >= HOUR_MS ? 'hourly' : 'snapshots', series: dbOut };
    }
    const out = {};
    for (const k of keys) out[k.key] = bucketize(fileSeries(k, from, to), from, to, bucketMs);
    return { from, to, bucketMs, source: 'file', degraded: true, series: out };
  });
}

// ---------------------------------------------------------------------------
// profile() — hour-of-day / weekday / weekday×hour heatmap ("peak times")
// ---------------------------------------------------------------------------

const LOCAL_SHIFT = `(hour_start AT TIME ZONE INTERVAL '${g.PG_OFFSET}')`;

async function profileDb(keys, fromMs, toMs) {
  const p = params();
  const from = p.add(iso(fromMs));
  const to = p.add(iso(toMs));
  const filter = tupleFilter(keys, p);
  const r = await db.sql(
    `SELECT game, server_id,
            (EXTRACT(isodow FROM ${LOCAL_SHIFT} - interval '${g.DAY_START_HOUR} hours'))::int AS dow,
            (EXTRACT(hour FROM ${LOCAL_SHIFT}))::int AS hr,
            MAX(peak) AS peak,
            SUM(sum_players)::float / NULLIF(SUM(online_samples), 0) AS avg,
            SUM(samples)::int AS n, SUM(online_samples)::int AS non
     FROM server_hourly
     WHERE hour_start >= ${from} AND hour_start < ${to} AND ${filter}
     GROUP BY 1, 2, 3, 4`,
    p.v
  );
  if (!r) return null;
  if (!r.rows.length) return { empty: true };
  return r.rows.map((row) => ({
    key: `${row.game}:${row.server_id}`,
    dow: Number(row.dow) % 7, // isodow 1..7 (Mon..Sun) -> 1..6,0
    hr: Number(row.hr),
    peak: row.peak == null ? null : Number(row.peak),
    avg: round(row.avg, 2),
    n: Number(row.n) || 0,
    on: Number(row.non) || 0,
  }));
}

/** Local weekday index (0=Sun..6=Sat) for an instant, on the 06:00 boundary. */
function localDow(ms) {
  const [y, m, d] = g.localDayKey(ms).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}
function localHour(ms) {
  return new Date(ms + g.OFFSET_MS).getUTCHours();
}

function profileFromCells(cells, keys) {
  const blank = () => ({
    heatmap: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => null)),
    hourly: Array.from({ length: 24 }, () => null),
    weekday: Array.from({ length: 7 }, () => null),
  });
  const acc = {};
  for (const k of keys) {
    acc[k.key] = {
      cells: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ sum: 0, on: 0, peak: null }))),
      hours: Array.from({ length: 24 }, () => ({ sum: 0, on: 0, peak: null })),
      days: Array.from({ length: 7 }, () => ({ sum: 0, on: 0, peak: null })),
    };
  }
  const bump = (slot, c) => {
    if (c.on) {
      slot.sum += c.avg * c.on;
      slot.on += c.on;
    }
    if (c.peak != null && (slot.peak == null || c.peak > slot.peak)) slot.peak = c.peak;
  };
  for (const c of cells) {
    const a = acc[c.key];
    if (!a || c.avg == null) continue;
    bump(a.cells[c.dow][c.hr], c);
    bump(a.hours[c.hr], c);
    bump(a.days[c.dow], c);
  }
  const out = {};
  for (const k of keys) {
    const a = acc[k.key];
    const o = blank();
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const s = a.cells[d][h];
        o.heatmap[d][h] = s.on ? { avg: round(s.sum / s.on, 1), peak: s.peak } : null;
      }
      const s = a.days[d];
      o.weekday[d] = s.on ? { avg: round(s.sum / s.on, 1), peak: s.peak } : null;
    }
    for (let h = 0; h < 24; h++) {
      const s = a.hours[h];
      o.hourly[h] = s.on ? { avg: round(s.sum / s.on, 1), peak: s.peak } : null;
    }
    out[k.key] = o;
  }
  return out;
}

/** @param {{keys, days?:number}} opts */
async function profile(opts) {
  const keys = parseKeys(opts.keys);
  const days = Math.max(1, Math.min(365, Number(opts.days) || 30));
  const to = Date.now();
  const from = g.localDayStart(to) - (days - 1) * g.DAY_MS;
  if (!keys.length) return { from, to, days, profiles: {} };

  return cached('profile', { k: keys.map((k) => k.key), days }, 60_000, async () => {
    const rows = await profileDb(keys, from, to);
    if (rows && !rows.empty) {
      return { from, to, days, source: 'hourly', profiles: profileFromCells(rows, keys) };
    }
    // No rollup yet (or DB down): fold the raw file samples into the same cells.
    const cells = [];
    for (const k of keys) {
      const byCell = new Map();
      for (const pt of fileSeries(k, from, to)) {
        if (!pt.on) continue;
        const cellKey = `${localDow(pt.t)}:${localHour(pt.t)}`;
        let c = byCell.get(cellKey);
        if (!c) {
          c = { key: k.key, dow: localDow(pt.t), hr: localHour(pt.t), sum: 0, on: 0, peak: null };
          byCell.set(cellKey, c);
        }
        c.sum += pt.v;
        c.on++;
        if (c.peak == null || pt.v > c.peak) c.peak = pt.v;
      }
      for (const c of byCell.values()) cells.push({ ...c, avg: c.on ? c.sum / c.on : null });
    }
    return { from, to, days, source: rows ? 'file' : 'file', degraded: true, profiles: profileFromCells(cells, keys) };
  });
}

// ---------------------------------------------------------------------------
// daily() — per local day: peak, average, player-hours, uptime
// ---------------------------------------------------------------------------

function emptyDay(day) {
  return { day, peak: null, low: null, avg: null, playerHours: 0, uptime: null, samples: 0 };
}

async function dailyDb(keys, fromMs, toMs) {
  const p = params();
  const from = p.add(iso(fromMs));
  const to = p.add(iso(toMs));
  const filter = tupleFilter(keys, p);
  const r = await db.sql(
    `SELECT game, server_id,
            to_char(date_trunc('day', ${LOCAL_SHIFT} - interval '${g.DAY_START_HOUR} hours'), 'YYYY-MM-DD') AS day,
            MAX(peak) AS peak, MIN(low) AS low, SUM(sum_players)::bigint AS sum_players,
            SUM(samples)::int AS n, SUM(online_samples)::int AS non
     FROM server_hourly
     WHERE hour_start >= ${from} AND hour_start < ${to} AND ${filter}
     GROUP BY 1, 2, 3`,
    p.v
  );
  if (!r) return null;
  if (!r.rows.length) return { empty: true };
  return r.rows.map((row) => ({
    key: `${row.game}:${row.server_id}`,
    day: row.day,
    peak: row.peak == null ? null : Number(row.peak),
    low: row.low == null ? null : Number(row.low),
    sum: Number(row.sum_players) || 0,
    n: Number(row.n) || 0,
    on: Number(row.non) || 0,
  }));
}

function foldDaily(rows, keys, dayKeys) {
  const out = {};
  for (const k of keys) {
    const byDay = Object.create(null);
    for (const d of dayKeys) byDay[d] = emptyDay(d);
    out[k.key] = byDay;
  }
  for (const row of rows) {
    const bucket = out[row.key];
    if (!bucket || !bucket[row.day]) continue;
    const e = bucket[row.day];
    e.peak = row.peak;
    e.low = row.low;
    e.avg = row.on ? round(row.sum / row.on, 2) : null;
    // One sample per minute, so the summed player counts *are* player-minutes.
    e.playerHours = round(row.sum / 60, 1);
    e.uptime = row.n ? round((row.on / row.n) * 100, 1) : null;
    e.samples = row.n;
  }
  const shaped = {};
  for (const k of keys) shaped[k.key] = dayKeys.map((d) => out[k.key][d]);
  return shaped;
}

/** @param {{keys, days?:number}} opts */
async function daily(opts) {
  const keys = parseKeys(opts.keys);
  const days = Math.max(2, Math.min(400, Number(opts.days) || 30));
  const to = Date.now();
  const from = g.localDayStart(to) - (days - 1) * g.DAY_MS;
  const dayKeys = g.lastNDayKeys(days, to);
  if (!keys.length) return { days: dayKeys, byKey: {} };

  return cached('daily', { k: keys.map((k) => k.key), days }, 60_000, async () => {
    const rows = await dailyDb(keys, from, to);
    if (rows && !rows.empty) {
      return { days: dayKeys, source: 'hourly', byKey: foldDaily(rows, keys, dayKeys) };
    }
    const fallback = [];
    for (const k of keys) {
      const byDay = new Map();
      for (const pt of fileSeries(k, from, to)) {
        const day = g.localDayKey(pt.t);
        let e = byDay.get(day);
        if (!e) {
          e = { key: k.key, day, peak: null, low: null, sum: 0, n: 0, on: 0 };
          byDay.set(day, e);
        }
        e.n++;
        if (pt.on) {
          e.on++;
          e.sum += pt.v;
          if (e.peak == null || pt.v > e.peak) e.peak = pt.v;
          if (e.low == null || pt.v < e.low) e.low = pt.v;
        }
      }
      fallback.push(...byDay.values());
    }
    return { days: dayKeys, source: 'file', degraded: true, byKey: foldDaily(fallback, keys, dayKeys) };
  });
}

// ---------------------------------------------------------------------------
// records() — all-time peak, best day, uptime, lifetime player-hours
// ---------------------------------------------------------------------------

async function records(opts) {
  const keys = parseKeys(opts.keys);
  if (!keys.length) return {};
  return cached('records', { k: keys.map((k) => k.key) }, 120_000, async () => {
    const out = {};
    for (const k of keys) {
      out[k.key] = {
        allTimePeak: null, allTimePeakAt: null, firstSeen: null, lastSeen: null,
        totalPlayerHours: null, uptime: null, avgAllTime: null, bestDay: null, bestDayPeak: null,
      };
    }

    const p = params();
    const filter = tupleFilter(keys, p);
    const agg = await db.sql(
      `SELECT game, server_id, MAX(peak) AS peak, MIN(hour_start) AS first_seen, MAX(hour_start) AS last_seen,
              SUM(sum_players)::bigint AS sum_players, SUM(samples)::bigint AS n, SUM(online_samples)::bigint AS non
       FROM server_hourly WHERE ${filter} GROUP BY 1, 2`,
      p.v
    );

    if (agg && agg.rows.length) {
      for (const row of agg.rows) {
        const key = `${row.game}:${row.server_id}`;
        const o = out[key];
        if (!o) continue;
        o.allTimePeak = row.peak == null ? null : Number(row.peak);
        o.firstSeen = row.first_seen ? new Date(row.first_seen).getTime() : null;
        o.lastSeen = row.last_seen ? new Date(row.last_seen).getTime() : null;
        o.totalPlayerHours = round(Number(row.sum_players) / 60, 0);
        o.uptime = Number(row.n) ? round((Number(row.non) / Number(row.n)) * 100, 1) : null;
        o.avgAllTime = Number(row.non) ? round(Number(row.sum_players) / Number(row.non), 1) : null;
      }
      // When the record was set (hour granularity is enough for a "record" line).
      const p2 = params();
      const f2 = tupleFilter(keys, p2);
      const whenR = await db.sql(
        `SELECT DISTINCT ON (game, server_id) game, server_id, hour_start, peak
         FROM server_hourly WHERE ${f2} AND peak IS NOT NULL
         ORDER BY game, server_id, peak DESC, hour_start ASC`,
        p2.v
      );
      if (whenR) {
        for (const row of whenR.rows) {
          const o = out[`${row.game}:${row.server_id}`];
          if (o) o.allTimePeakAt = new Date(row.hour_start).getTime();
        }
      }
      const p3 = params();
      const f3 = tupleFilter(keys, p3);
      const bestR = await db.sql(
        `SELECT DISTINCT ON (game, server_id) game, server_id, day, peak FROM (
           SELECT game, server_id,
                  to_char(date_trunc('day', ${LOCAL_SHIFT} - interval '${g.DAY_START_HOUR} hours'), 'YYYY-MM-DD') AS day,
                  MAX(peak) AS peak
           FROM server_hourly WHERE ${f3} GROUP BY 1, 2, 3
         ) d WHERE peak IS NOT NULL ORDER BY game, server_id, peak DESC, day DESC`,
        p3.v
      );
      if (bestR) {
        for (const row of bestR.rows) {
          const o = out[`${row.game}:${row.server_id}`];
          if (o) {
            o.bestDay = row.day;
            o.bestDayPeak = Number(row.peak);
          }
        }
      }
      return out;
    }

    // File fallback: whatever the ~8-day cache holds.
    const from = stats.earliestSampleMs() || Date.now() - 8 * g.DAY_MS;
    for (const k of keys) {
      const pts = fileSeries(k, from, Date.now());
      if (!pts.length) continue;
      const o = out[k.key];
      let sum = 0;
      let on = 0;
      const byDay = new Map();
      for (const pt of pts) {
        if (!pt.on) continue;
        on++;
        sum += pt.v;
        if (o.allTimePeak == null || pt.v > o.allTimePeak) {
          o.allTimePeak = pt.v;
          o.allTimePeakAt = pt.t;
        }
        const day = g.localDayKey(pt.t);
        byDay.set(day, Math.max(byDay.get(day) || 0, pt.v));
      }
      o.firstSeen = pts[0].t;
      o.lastSeen = pts[pts.length - 1].t;
      o.totalPlayerHours = round(sum / 60, 0);
      o.uptime = round((on / pts.length) * 100, 1);
      o.avgAllTime = on ? round(sum / on, 1) : null;
      for (const [day, peak] of byDay) {
        if (o.bestDayPeak == null || peak > o.bestDayPeak) {
          o.bestDay = day;
          o.bestDayPeak = peak;
        }
      }
      o.partial = true; // only the file window was available
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// listServers() / leaderboard() / summary()
// ---------------------------------------------------------------------------

async function listServers() {
  const meta = await db.getServerMeta();
  const now = Date.now();
  return configuredServers().map((s) => {
    const key = `${s.game}:${s.id}`;
    const m = meta[key] || {};
    const latest = stats.getLatest(s.game, s.id);
    return {
      key,
      game: s.game,
      id: s.id,
      name: m.name || s.name || s.id,
      address: m.address || (s.host ? `${s.host}:${s.port}` : s.code ? `cfx.re/join/${s.code}` : ''),
      code: s.code || null,
      maxSlots: m.maxSlots || null,
      players: latest ? latest.players : null,
      lastSampleAt: latest ? latest.ts : null,
      // A sample older than ~3 polls means the poller is not seeing it at all.
      online: !!(latest && now - latest.ts < 4 * SAMPLE_MS),
      firstSeen: m.firstSeen || null,
      lastSeen: m.lastSeen || null,
      spark: stats.getSparkline(s.game, s.id, 32),
    };
  });
}

/** Aggregate keys that always exist, for pickers and the overview. */
function aggregateKeys() {
  const games = new Set(configuredServers().map((s) => s.game));
  const out = [{ key: `${ALL_GAME}:${TOTAL_ID}`, name: 'All servers (total)', game: ALL_GAME, aggregate: true }];
  for (const game of games) {
    out.push({ key: `${game}:${TOTAL_ID}`, name: `${game.toUpperCase()} — total`, game, aggregate: true });
  }
  return out;
}

const GAME_LABEL = { ragemp: 'RAGE MP', redm: 'RedM', samp: 'SA-MP' };

/**
 * Everything the overview tab needs in one round-trip: KPI tiles, the ranked
 * table (with period-over-period growth), and per-game splits.
 */
async function summary(opts = {}) {
  const days = Math.max(1, Math.min(365, Number(opts.days) || 7));
  const servers = await listServers();
  const keys = servers.map((s) => s.key);
  const aggKey = `${ALL_GAME}:${TOTAL_ID}`;
  // Per-game totals are their own series (the peak of a game's summed curve),
  // so they have to be asked for explicitly rather than derived from the rows.
  const gameKeys = [...new Set(servers.map((s) => `${s.game}:${TOTAL_ID}`))];
  const allKeys = keys.concat(gameKeys, aggKey);

  const now = Date.now();
  const periodMs = days * g.DAY_MS;
  const from = g.localDayStart(now) - (days - 1) * g.DAY_MS;
  const prevFrom = from - periodMs;

  const [cur, prev, rec, dayRows] = await Promise.all([
    windowStats(allKeys, from, now),
    windowStats(allKeys, prevFrom, from),
    records({ keys: allKeys }),
    daily({ keys: [aggKey], days }),
  ]);

  const rows = servers.map((s) => {
    const c = cur[s.key] || {};
    const p = prev[s.key] || {};
    const r = rec[s.key] || {};
    const growth = p.avg && c.avg != null ? round(((c.avg - p.avg) / p.avg) * 100, 1) : null;
    return {
      ...s,
      now: s.online ? s.players : 0,
      peak: c.peak ?? null,
      avg: c.avg ?? null,
      low: c.low ?? null,
      playerHours: c.playerHours ?? 0,
      uptime: c.uptime ?? null,
      todayPeak: c.todayPeak ?? null,
      growth,
      prevAvg: p.avg ?? null,
      allTimePeak: r.allTimePeak ?? null,
      allTimePeakAt: r.allTimePeakAt ?? null,
      fill: s.maxSlots && c.peak != null ? round((c.peak / s.maxSlots) * 100, 1) : null,
    };
  });

  const totalPlayerHours = rows.reduce((a, r) => a + (r.playerHours || 0), 0);
  for (const r of rows) r.share = totalPlayerHours ? round((r.playerHours / totalPlayerHours) * 100, 1) : null;
  rows.sort((a, b) => (b.peak || 0) - (a.peak || 0));

  const byGame = {};
  for (const r of rows) {
    const b = (byGame[r.game] = byGame[r.game] || {
      game: r.game, label: GAME_LABEL[r.game] || r.game, servers: 0, online: 0, now: 0, playerHours: 0,
    });
    b.servers++;
    if (r.online) b.online++;
    b.now += r.now || 0;
    b.playerHours += r.playerHours || 0;
  }
  for (const b of Object.values(byGame)) {
    const c = cur[`${b.game}:${TOTAL_ID}`] || {};
    b.peak = c.peak ?? null;
    b.avg = c.avg ?? null;
    b.playerHours = round(b.playerHours, 1);
  }

  const total = cur[aggKey] || {};
  const totalPrev = prev[aggKey] || {};
  const totalRec = rec[aggKey] || {};

  return {
    days,
    from,
    to: now,
    generatedAt: now,
    degraded: !!(total.degraded || cur.__degraded),
    kpi: {
      now: rows.reduce((a, r) => a + (r.now || 0), 0),
      todayPeak: total.todayPeak ?? null,
      peak: total.peak ?? null,
      avg: total.avg ?? null,
      prevAvg: totalPrev.avg ?? null,
      growth: totalPrev.avg && total.avg != null ? round(((total.avg - totalPrev.avg) / totalPrev.avg) * 100, 1) : null,
      allTimePeak: totalRec.allTimePeak ?? null,
      allTimePeakAt: totalRec.allTimePeakAt ?? null,
      playerHours: round(totalPlayerHours, 0),
      serversOnline: rows.filter((r) => r.online).length,
      serversTotal: rows.length,
      uptime: rows.length
        ? round(rows.reduce((a, r) => a + (r.uptime || 0), 0) / rows.filter((r) => r.uptime != null).length || 0, 1)
        : null,
    },
    rows,
    byGame: Object.values(byGame).sort((a, b) => (b.peak || 0) - (a.peak || 0)),
    dailyTotal: dayRows.byKey[aggKey] || [],
  };
}

function shapeWindow(row) {
  const n = Number(row.n) || 0;
  const non = Number(row.non) || 0;
  const sum = Number(row.sum_players) || 0;
  return {
    peak: row.peak == null ? null : Number(row.peak),
    low: row.low == null ? null : Number(row.low),
    avg: non ? round(sum / non, 1) : null,
    playerHours: round(sum / 60, 1),
    uptime: n ? round((non / n) * 100, 1) : null,
    todayPeak: row.today_peak == null ? null : Number(row.today_peak),
  };
}

/** Peak / avg / low / uptime / player-hours for each key over one window. */
async function windowStats(keyList, fromMs, toMs) {
  const keys = parseKeys(keyList);
  if (!keys.length) return {};
  const todayStart = g.localDayStart(Date.now());

  // Long windows are measured on the hourly rollup, short ones on raw
  // snapshots — the same rule the series endpoint uses. An empty rollup (fresh
  // install, backfill not run yet) falls through to raw rather than reporting
  // a server with data as blank.
  const useHourly = toMs - fromMs > 2 * g.DAY_MS;

  const fromHourly = async () => {
    const p = params();
    const from = p.add(iso(fromMs));
    const to = p.add(iso(toMs));
    const filter = tupleFilter(keys, p);
    const today = p.add(iso(todayStart));
    const r = await db.sql(
      `SELECT game, server_id, MAX(peak) AS peak, MIN(low) AS low,
              SUM(sum_players)::bigint AS sum_players, SUM(samples)::bigint AS n, SUM(online_samples)::bigint AS non,
              MAX(peak) FILTER (WHERE hour_start >= ${today}) AS today_peak
       FROM server_hourly WHERE hour_start >= ${from} AND hour_start < ${to} AND ${filter}
       GROUP BY 1, 2`,
      p.v
    );
    if (!r || !r.rows.length) return null;
    const out = {};
    for (const row of r.rows) out[`${row.game}:${row.server_id}`] = shapeWindow(row);
    return out;
  };

  const fromRaw = async () => {
    const out = {};
    const plain = keys.filter((k) => !k.aggregate);
    if (plain.length) {
      const p = params();
      const from = p.add(iso(fromMs));
      const to = p.add(iso(toMs));
      const filter = tupleFilter(plain, p);
      const today = p.add(iso(todayStart));
      const r = await db.sql(
        `SELECT game, server_id,
                MAX(players) FILTER (WHERE online) AS peak,
                MIN(players) FILTER (WHERE online) AS low,
                COALESCE(SUM(players) FILTER (WHERE online), 0)::bigint AS sum_players,
                COUNT(*)::bigint AS n, COUNT(*) FILTER (WHERE online)::bigint AS non,
                MAX(players) FILTER (WHERE online AND ts >= ${today}) AS today_peak
         FROM snapshots WHERE ts >= ${from} AND ts < ${to} AND ${filter}
         GROUP BY 1, 2`,
        p.v
      );
      if (!r) return null;
      for (const row of r.rows) out[`${row.game}:${row.server_id}`] = shapeWindow(row);
    }
    for (const k of keys.filter((x) => x.aggregate)) {
      const p = params();
      const from = p.add(iso(fromMs));
      const to = p.add(iso(toMs));
      const gameFilter = k.all ? '' : ` AND game = ${p.add(k.game)}`;
      const today = p.add(iso(todayStart));
      const r = await db.sql(
        `WITH per_ts AS (
           SELECT ts, COALESCE(SUM(players) FILTER (WHERE online), 0) AS tot,
                  COUNT(*) FILTER (WHERE online) AS non
           FROM snapshots WHERE ts >= ${from} AND ts < ${to}${gameFilter} GROUP BY ts
         )
         SELECT MAX(tot) AS peak, MIN(tot) AS low, COALESCE(SUM(tot), 0)::bigint AS sum_players,
                COUNT(*)::bigint AS n, COUNT(*) FILTER (WHERE non > 0)::bigint AS non,
                MAX(tot) FILTER (WHERE ts >= ${today}) AS today_peak
         FROM per_ts`,
        p.v
      );
      if (!r) return null;
      out[k.key] = shapeWindow(r.rows[0] || {});
    }
    return Object.keys(out).length ? out : null;
  };

  const dbOut = (useHourly ? await fromHourly() : null) || (await fromRaw());
  if (dbOut) {
    for (const k of keys) if (!dbOut[k.key]) dbOut[k.key] = {};
    return dbOut;
  }

  // File fallback.
  const out = {};
  for (const k of keys) {
    const pts = fileSeries(k, fromMs, toMs);
    let peak = null;
    let low = null;
    let sum = 0;
    let on = 0;
    let todayPeak = null;
    for (const pt of pts) {
      if (!pt.on) continue;
      on++;
      sum += pt.v;
      if (peak == null || pt.v > peak) peak = pt.v;
      if (low == null || pt.v < low) low = pt.v;
      if (pt.t >= todayStart && (todayPeak == null || pt.v > todayPeak)) todayPeak = pt.v;
    }
    out[k.key] = {
      peak,
      low,
      avg: on ? round(sum / on, 1) : null,
      playerHours: round(sum / 60, 1),
      uptime: pts.length ? round((on / pts.length) * 100, 1) : null,
      todayPeak,
      degraded: true,
    };
  }
  out.__degraded = true;
  return out;
}

// ---------------------------------------------------------------------------
// compare() — head-to-head payload for two or more servers
// ---------------------------------------------------------------------------

async function compare(opts) {
  const keys = parseKeys(opts.keys);
  const days = Math.max(1, Math.min(365, Number(opts.days) || 14));
  if (!keys.length) return { keys: [], days, metrics: {} };
  const to = Date.now();
  const from = g.localDayStart(to) - (days - 1) * g.DAY_MS;

  const [win, rec, prof, day] = await Promise.all([
    windowStats(keys.map((k) => k.key), from, to),
    records({ keys: keys.map((k) => k.key) }),
    profile({ keys: keys.map((k) => k.key), days }),
    daily({ keys: keys.map((k) => k.key), days }),
  ]);

  const metrics = {};
  for (const k of keys) {
    const w = win[k.key] || {};
    const r = rec[k.key] || {};
    const prf = prof.profiles[k.key];
    let bestHour = null;
    let bestHourAvg = -1;
    if (prf) {
      prf.hourly.forEach((h, i) => {
        if (h && h.avg > bestHourAvg) {
          bestHourAvg = h.avg;
          bestHour = i;
        }
      });
    }
    let bestDow = null;
    let bestDowAvg = -1;
    if (prf) {
      prf.weekday.forEach((d, i) => {
        if (d && d.avg > bestDowAvg) {
          bestDowAvg = d.avg;
          bestDow = i;
        }
      });
    }
    const series = day.byKey[k.key] || [];
    const withData = series.filter((d) => d.peak != null);
    const half = Math.floor(withData.length / 2);
    const firstHalf = withData.slice(0, half);
    const lastHalf = withData.slice(half);
    const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + (b.avg || 0), 0) / arr.length : null);
    const a = mean(firstHalf);
    const b = mean(lastHalf);
    metrics[k.key] = {
      ...w,
      allTimePeak: r.allTimePeak ?? null,
      allTimePeakAt: r.allTimePeakAt ?? null,
      bestDay: r.bestDay ?? null,
      bestDayPeak: r.bestDayPeak ?? null,
      firstSeen: r.firstSeen ?? null,
      bestHour,
      bestHourAvg: bestHourAvg >= 0 ? round(bestHourAvg, 1) : null,
      bestDow,
      bestDowAvg: bestDowAvg >= 0 ? round(bestDowAvg, 1) : null,
      trend: a && b ? round(((b - a) / a) * 100, 1) : null,
      daysWithData: withData.length,
      consistency: consistency(withData.map((d) => d.avg).filter((x) => x != null)),
    };
  }
  return { keys: keys.map((k) => k.key), days, from, to, metrics, profiles: prof.profiles, daily: day };
}

/** 100 = perfectly steady day to day; lower = spikier. (1 - CV, floored at 0.) */
function consistency(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (!mean) return null;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const cv = Math.sqrt(variance) / mean;
  return round(Math.max(0, 1 - cv) * 100, 0);
}

module.exports = {
  TOTAL_ID,
  ALL_GAME,
  GAME_LABEL,
  setConfigProvider,
  invalidate,
  parseKeys,
  pickBucket,
  listServers,
  aggregateKeys,
  series,
  profile,
  daily,
  records,
  summary,
  compare,
  windowStats,
};
