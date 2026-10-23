'use strict';

/**
 * Stats panel routes: the `/stats` page shell and the read-only JSON API it
 * runs on. All computation lives in analytics.js — this module only validates
 * query strings, shapes responses and renders CSV.
 *
 * Every route here is mounted behind the admin session check in admin.js.
 */

const analytics = require('./analytics');
const g = require('./gtime');

const MAX_DAYS = 400;

function num(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(res, filename, header, rows) {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${filename}"`);
  res.end('﻿' + body); // BOM so Excel reads UTF-8 server names correctly
}

function page(layout) {
  const body = `<div id="app"><div class="panel"><div class="empty">Loading…</div></div></div>
<link rel="stylesheet" href="/panel.css">
<script>window.UTC_OFFSET_MS=${Number(g.OFFSET_MS)};window.DAY_START_HOUR=${Number(g.DAY_START_HOUR)};</script>
<script src="/charts.js"></script>
<script src="/stats.js"></script>`;
  return layout('Stats', body, { wide: true });
}

function mount(app, deps) {
  const { db, stats, layout } = deps;

  app.get('/stats', (req, res) => {
    res.send(page(layout));
  });

  const json = (res, fn) =>
    Promise.resolve()
      .then(fn)
      .then((data) => {
        res.setHeader('cache-control', 'no-store');
        res.json(data);
      })
      .catch((e) => res.status(500).json({ error: e.message }));

  app.get('/api/stats/servers', (req, res) =>
    json(res, async () => ({
      servers: await analytics.listServers(),
      aggregates: analytics.aggregateKeys(),
      generatedAt: Date.now(),
    }))
  );

  app.get('/api/stats/summary', (req, res) =>
    json(res, () => analytics.summary({ days: num(req.query.days, 7, 1, MAX_DAYS) }))
  );

  app.get('/api/stats/series', (req, res) =>
    json(res, () => {
      const to = num(req.query.to, Date.now(), 0, Date.now() + 6e4);
      const from = num(req.query.from, to - 7 * g.DAY_MS, 0, to - 6e4);
      return analytics.series({
        keys: req.query.keys,
        from,
        to,
        points: num(req.query.points, 320, 20, 1200),
      });
    })
  );

  app.get('/api/stats/profile', (req, res) =>
    json(res, () => analytics.profile({ keys: req.query.keys, days: num(req.query.days, 30, 1, MAX_DAYS) }))
  );

  app.get('/api/stats/daily', (req, res) =>
    json(res, () => analytics.daily({ keys: req.query.keys, days: num(req.query.days, 30, 2, MAX_DAYS) }))
  );

  app.get('/api/stats/records', (req, res) => json(res, () => analytics.records({ keys: req.query.keys })));

  app.get('/api/stats/compare', (req, res) =>
    json(res, () => analytics.compare({ keys: req.query.keys, days: num(req.query.days, 14, 1, MAX_DAYS) }))
  );

  app.get('/api/stats/health', (req, res) =>
    json(res, async () => {
      const [dbState, snapCount] = await Promise.all([db.getDbState(), db.getSnapshotCount()]);
      const hourly = await db.sql('SELECT count(*)::bigint AS c, MIN(hour_start) AS oldest FROM server_hourly');
      const servers = await analytics.listServers();
      const lastSampleAt = servers.reduce((a, s) => Math.max(a, s.lastSampleAt || 0), 0);
      const oldest = hourly && hourly.rows[0].oldest ? new Date(hourly.rows[0].oldest).getTime() : null;
      return {
        db: { enabled: dbState.enabled, up: dbState.up, lastError: dbState.lastError || null },
        snapshots: snapCount,
        hourly: hourly ? Number(hourly.rows[0].c) : null,
        historyDays: oldest ? Math.round((Date.now() - oldest) / g.DAY_MS) : null,
        file: stats.getFileStats(),
        lastSampleAt: lastSampleAt || null,
        retention: { snapshotDays: 90, hourlyDays: 1095 },
        generatedAt: Date.now(),
      };
    })
  );

  // ---- CSV export ---------------------------------------------------------
  app.get('/api/stats/export.csv', async (req, res) => {
    const type = String(req.query.type || 'leaderboard');
    const days = num(req.query.days, 30, 1, MAX_DAYS);
    const stamp = g.localDayKey();
    try {
      if (type === 'leaderboard') {
        const sum = await analytics.summary({ days });
        return csv(
          res,
          `rp-stats-leaderboard-${days}d-${stamp}.csv`,
          ['game', 'server_id', 'name', 'address', 'now', 'today_peak', 'peak', 'avg', 'low',
            'player_hours', 'share_pct', 'uptime_pct', 'growth_pct', 'all_time_peak', 'all_time_peak_at'],
          sum.rows.map((r) => [
            r.game, r.id, r.name, r.address, r.now, r.todayPeak, r.peak, r.avg, r.low,
            r.playerHours, r.share, r.uptime, r.growth, r.allTimePeak,
            r.allTimePeakAt ? g.localDateTimeString(r.allTimePeakAt) : '',
          ])
        );
      }

      const keys = req.query.keys || (await analytics.listServers()).map((s) => s.key).join(',');

      if (type === 'daily') {
        const d = await analytics.daily({ keys, days });
        const rows = [];
        for (const [key, list] of Object.entries(d.byKey)) {
          for (const e of list) {
            rows.push([key, e.day, g.weekdayShort(e.day), e.peak, e.avg, e.low, e.playerHours, e.uptime, e.samples]);
          }
        }
        return csv(res, `rp-stats-daily-${days}d-${stamp}.csv`,
          ['key', 'day', 'weekday', 'peak', 'avg', 'low', 'player_hours', 'uptime_pct', 'samples'], rows);
      }

      if (type === 'hourly') {
        const to = Date.now();
        const from = g.localDayStart(to) - (days - 1) * g.DAY_MS;
        const s = await analytics.series({ keys, from, to, bucketMs: 60 * 60 * 1000 });
        const rows = [];
        for (const [key, list] of Object.entries(s.series)) {
          for (const p of list) {
            rows.push([key, new Date(p.t).toISOString(), g.localDateTimeString(p.t), p.peak, p.avg, p.low, p.n, p.on]);
          }
        }
        return csv(res, `rp-stats-hourly-${days}d-${stamp}.csv`,
          ['key', 'hour_utc', 'hour_local', 'peak', 'avg', 'low', 'samples', 'online_samples'], rows);
      }

      if (type === 'profile') {
        const p = await analytics.profile({ keys, days });
        const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const rows = [];
        for (const [key, prof] of Object.entries(p.profiles)) {
          for (let d = 0; d < 7; d++) {
            for (let h = 0; h < 24; h++) {
              const c = prof.heatmap[d][h];
              rows.push([key, dow[d], `${String(h).padStart(2, '0')}:00`, c ? c.avg : '', c ? c.peak : '']);
            }
          }
        }
        return csv(res, `rp-stats-peaktimes-${days}d-${stamp}.csv`,
          ['key', 'weekday', 'hour_local', 'avg_players', 'peak_players'], rows);
      }

      res.status(400).json({ error: 'unknown export type' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { mount };
