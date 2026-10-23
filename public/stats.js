/* Stats panel application.
 *
 * Five views over one JSON API: Overview, Servers, Compare, Peak times and a
 * per-server Detail. State (tab, range, selection) lives in the URL hash so any
 * view can be linked to or reloaded.
 */
(function () {
  'use strict';

  var C = window.Charts;
  var esc = C.esc, fmt = C.fmtNum;
  var ALL = '@all:@total';

  var RANGES = [
    { id: '24h', label: '24h', ms: 864e5, days: 1 },
    { id: '48h', label: '48h', ms: 2 * 864e5, days: 2 },
    { id: '7d', label: '7d', ms: 7 * 864e5, days: 7 },
    { id: '14d', label: '14d', ms: 14 * 864e5, days: 14 },
    { id: '30d', label: '30d', ms: 30 * 864e5, days: 30 },
    { id: '90d', label: '90d', ms: 90 * 864e5, days: 90 },
    { id: '1y', label: '1y', ms: 365 * 864e5, days: 365 },
  ];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // The local day runs DAY_START -> DAY_START, so profiles read in that order.
  var DAY_START = Number(window.DAY_START_HOUR) || 0;
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  var HOURS = [];
  for (var h = 0; h < 24; h++) HOURS.push((DAY_START + h) % 24);

  var S = {
    tab: 'overview',
    range: '7d',
    sel: [],          // compare / peaks selection
    detail: null,     // key of the server being inspected
    zoom: null,       // [from,to] override for the overview chart
    sort: { col: 'peak', dir: -1 },
    servers: [],
    byKey: {},
    summary: null,
    live: true,
  };

  var root = document.getElementById('app');
  var charts = {};   // live chart instances, disposed on view change

  // ---------------------------------------------------------------- helpers
  function range() {
    for (var i = 0; i < RANGES.length; i++) if (RANGES[i].id === S.range) return RANGES[i];
    return RANGES[2];
  }

  function api(path, q) {
    var qs = Object.keys(q || {})
      .filter(function (k) { return q[k] != null && q[k] !== ''; })
      .map(function (k) { return k + '=' + encodeURIComponent(q[k]); })
      .join('&');
    return fetch('/api/stats/' + path + (qs ? '?' + qs : ''), { headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401 || r.redirected) { location.href = '/login'; throw new Error('auth'); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }

  function name(key) {
    if (key === ALL) return 'All servers';
    var s = S.byKey[key];
    if (s) return s.name;
    var p = key.split(':');
    if (p[1] === '@total') return (p[0] || '').toUpperCase() + ' total';
    return p[1] || key;
  }

  function keyColor(key) {
    var i = S.servers.findIndex(function (s) { return s.key === key; });
    return key === ALL ? '#58a6ff' : C.color(i < 0 ? 0 : i);
  }

  function delta(v, suffix) {
    if (v == null) return '<span class="delta flat">—</span>';
    var cls = v > 1 ? 'up' : v < -1 ? 'down' : 'flat';
    var arrow = v > 1 ? '▲' : v < -1 ? '▼' : '·';
    return '<span class="delta ' + cls + '">' + arrow + ' ' + Math.abs(v).toFixed(1) + (suffix || '%') + '</span>';
  }

  function ago(ms) {
    if (!ms) return '—';
    var d = Date.now() - ms;
    if (d < 6e4) return 'just now';
    if (d < 36e5) return Math.round(d / 6e4) + 'm ago';
    if (d < 864e5) return Math.round(d / 36e5) + 'h ago';
    return Math.round(d / 864e5) + 'd ago';
  }

  function hourLabel(h) {
    return (h < 10 ? '0' : '') + h + ':00';
  }

  function setHash() {
    var parts = ['tab=' + S.tab, 'range=' + S.range];
    if (S.sel.length) parts.push('sel=' + S.sel.join(','));
    if (S.detail) parts.push('s=' + S.detail);
    history.replaceState(null, '', '#' + parts.join('&'));
  }

  function readHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return;
    h.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i < 0) return;
      var k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1));
      if (k === 'tab') S.tab = v;
      else if (k === 'range') S.range = v;
      else if (k === 'sel') S.sel = v.split(',').filter(Boolean);
      else if (k === 's') S.detail = v;
    });
  }

  function disposeCharts() {
    Object.keys(charts).forEach(function (k) {
      if (charts[k] && charts[k].destroy) charts[k].destroy();
      delete charts[k];
    });
  }

  function panel(title, note, id, extra) {
    return '<div class="panel"><h3>' + esc(title) +
      (note ? '<span class="note">' + note + '</span>' : '') + '<span class="sp"></span>' +
      (extra || '') + '</h3><div id="' + id + '"></div></div>';
  }

  // ------------------------------------------------------------------ chrome
  function renderChrome() {
    var tabs = [
      ['overview', 'Overview'], ['servers', 'Servers'], ['compare', 'Compare'],
      ['peaks', 'Peak times'], ['data', 'Data & export'],
    ];
    var html = '<div class="toolbar">' +
      '<div class="tabs">' + tabs.map(function (t) {
        return '<button data-tab="' + t[0] + '" class="' + (S.tab === t[0] && !S.detail ? 'on' : '') + '">' + t[1] + '</button>';
      }).join('') + '</div>' +
      '<span class="sp"></span>' +
      '<span class="tool-label">Range</span>' +
      '<div class="seg" id="rangeseg">' + RANGES.map(function (r) {
        return '<button data-range="' + r.id + '" class="' + (S.range === r.id ? 'on' : '') + '">' + r.label + '</button>';
      }).join('') + '</div>' +
      '<span class="live' + (S.live ? '' : ' stale') + '" id="livebadge"><i></i><span>live</span></span>' +
      '</div><div id="view"></div>';
    root.innerHTML = html;

    root.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        S.tab = b.getAttribute('data-tab');
        S.detail = null;
        S.zoom = null;
        go();
      });
    });
    root.querySelectorAll('[data-range]').forEach(function (b) {
      b.addEventListener('click', function () {
        S.range = b.getAttribute('data-range');
        S.zoom = null;
        go();
      });
    });
  }

  function view() {
    return document.getElementById('view');
  }

  function loading() {
    view().innerHTML = '<div class="panel"><div class="empty">Loading…</div></div>';
  }

  // ---------------------------------------------------------------- OVERVIEW
  function renderOverview() {
    var r = range();
    loading();
    Promise.all([
      api('summary', { days: r.days }),
      api('series', { keys: gameKeys().join(','), from: S.zoom ? S.zoom[0] : Date.now() - r.ms, to: S.zoom ? S.zoom[1] : Date.now(), points: 360 }),
      api('profile', { keys: ALL, days: Math.min(90, Math.max(7, r.days)) }),
      api('daily', { keys: ALL, days: Math.min(120, Math.max(14, r.days)) }),
    ]).then(function (res) {
      var sum = res[0], ser = res[1], prof = res[2], day = res[3];
      S.summary = sum;
      indexServers(sum.rows);
      drawOverview(sum, ser, prof, day);
    }).catch(showError);
  }

  function gameKeys() {
    var games = {};
    S.servers.forEach(function (s) { games[s.game] = 1; });
    var keys = [ALL];
    Object.keys(games).forEach(function (g) { keys.push(g + ':@total'); });
    return keys;
  }

  function kpi(label, value, sub, spark) {
    return '<div class="kpi"><div class="k-l">' + esc(label) + '</div><div class="k-v">' + value + '</div>' +
      (sub ? '<div class="k-s">' + sub + '</div>' : '') +
      (spark ? '<div class="k-spark">' + spark + '</div>' : '') + '</div>';
  }

  function drawOverview(sum, ser, prof, day) {
    var k = sum.kpi;
    var r = range();
    var dailyTotal = sum.dailyTotal || [];

    var html = '';
    if (sum.degraded || ser.degraded) {
      html += '<div class="banner">⚠️ Postgres is unavailable — showing the local ~8-day cache. ' +
        'Long-range history and all-time records are unavailable until the database is back.</div>';
    }

    html += '<div class="kpis">' +
      kpi('Players now', fmt(k.now), k.serversOnline + '/' + k.serversTotal + ' servers online',
        C.sparkline(dailyTotal.map(function (d) { return d.peak; }), 76, 20, '#58a6ff')) +
      kpi('Today\'s peak', fmt(k.todayPeak), 'local day boundary') +
      kpi(r.label + ' peak', fmt(k.peak), 'highest concurrent total') +
      kpi(r.label + ' average', fmt(k.avg, 1), delta(k.growth) + ' vs previous ' + r.label) +
      kpi('All-time peak', fmt(k.allTimePeak), k.allTimePeakAt ? C.fmtStamp(k.allTimePeakAt) : '—') +
      kpi('Player-hours', fmt(k.playerHours), 'total tracked over ' + r.label) +
      kpi('Avg uptime', k.uptime == null ? '—' : k.uptime + '%', 'across tracked servers') +
      kpi('Servers tracked', fmt(k.serversTotal), sum.byGame.map(function (g) { return g.label + ' ' + g.servers; }).join(' · ')) +
      '</div>';

    html += panel('Concurrent players', S.zoom ? 'zoomed — drag to zoom, click reset' : 'drag on the chart to zoom', 'ch-total',
      '<div class="seg" id="modeseg">' +
      '<button data-mode="area" class="on">Total</button>' +
      '<button data-mode="stack">By game</button>' +
      '<button data-mode="line">Lines</button></div>' +
      (S.zoom ? '<button class="linkbtn" id="resetzoom" style="margin-left:10px">reset zoom</button>' : ''));

    html += '<div class="grid2">' +
      panel('Daily peak', 'per local day, dashed = 7-day average', 'ch-daily') +
      panel('When players are online', 'average concurrent players by weekday × hour', 'ch-heat') +
      '</div>';

    html += '<div class="grid2">' +
      panel('Share of player-hours', 'top servers over ' + r.label, 'ch-share') +
      panel('By game', 'peak and player-hours over ' + r.label, 'ch-games') +
      '</div>';

    html += '<div class="panel"><h3>Server leaderboard<span class="note">' + r.label +
      ' — click a row for the full breakdown</span><span class="sp"></span>' +
      '<button class="linkbtn" id="csvlb">export CSV</button></h3><div class="tbl-wrap" id="lb"></div></div>';

    view().innerHTML = html;

    // total chart
    charts.total = C.TimeChart(document.getElementById('ch-total'), {
      height: 300, mode: 'area',
      onZoom: function (a, b) { S.zoom = [a, b]; go(); },
    });
    applyTotalSeries(ser, 'area');
    document.querySelectorAll('#modeseg button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#modeseg button').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        applyTotalSeries(ser, b.getAttribute('data-mode'));
      });
    });
    var rz = document.getElementById('resetzoom');
    if (rz) rz.addEventListener('click', function () { S.zoom = null; go(); });

    // daily bars + moving average
    charts.daily = C.BarChart(document.getElementById('ch-daily'), { height: 210, valueLabel: 'peak' });
    var rows = day.byKey[ALL] || [];
    charts.daily.setData({
      bars: rows.map(function (d) {
        return {
          label: d.day, short: d.day.slice(5).replace('-', '/'), value: d.peak || 0,
          sub: 'avg ' + fmt(d.avg, 1) + ' · ' + fmt(d.playerHours, 0) + ' player-h' +
            (d.uptime == null ? '' : ' · uptime ' + d.uptime + '%'),
        };
      }),
      line: movingAvg(rows.map(function (d) { return d.peak; }), 7),
    });

    // heatmap
    charts.heat = C.Heatmap(document.getElementById('ch-heat'), { valueLabel: 'avg players' });
    charts.heat.setData(heatData(prof.profiles[ALL]));

    // share donut
    charts.share = C.Donut(document.getElementById('ch-share'), {
      height: 210, unit: 'player-hours',
      center: fmt(k.playerHours), centerSub: 'player-hours',
    });
    var top = sum.rows.slice().sort(function (a, b) { return (b.playerHours || 0) - (a.playerHours || 0); });
    var shown = top.slice(0, 9).map(function (s, i) {
      return { label: s.name, value: s.playerHours || 0, color: C.color(i) };
    });
    var rest = top.slice(9).reduce(function (a, s) { return a + (s.playerHours || 0); }, 0);
    if (rest > 0) shown.push({ label: 'Other (' + (top.length - 9) + ')', value: rest, color: '#30363d' });
    charts.share.setData(shown);

    // by-game bars
    charts.games = C.CategoryChart(document.getElementById('ch-games'), { height: 210, mode: 'bar' });
    charts.games.setData({
      cats: sum.byGame.map(function (g) { return g.label; }),
      series: [
        { key: 'peak', name: 'Peak', color: '#58a6ff', values: sum.byGame.map(function (g) { return g.peak; }) },
        { key: 'avg', name: 'Average', color: '#3fb950', values: sum.byGame.map(function (g) { return g.avg; }) },
      ],
    });

    renderLeaderboard(sum);
    document.getElementById('csvlb').addEventListener('click', function () {
      location.href = '/api/stats/export.csv?type=leaderboard&days=' + r.days;
    });
  }

  function applyTotalSeries(ser, mode) {
    var keys = Object.keys(ser.series);
    var list;
    if (mode === 'stack') {
      list = keys.filter(function (k) { return k !== ALL; });
    } else if (mode === 'line') {
      list = keys;
    } else {
      list = [ALL];
    }
    charts.total.setMode(mode === 'stack' ? 'stack' : mode === 'line' ? 'line' : 'area');
    charts.total.setData({
      from: ser.from, to: ser.to,
      series: list.map(function (key, i) {
        return {
          key: key,
          name: key === ALL ? 'All servers' : key.split(':')[0].toUpperCase(),
          color: key === ALL ? '#58a6ff' : C.color(i),
          band: mode !== 'stack',
          points: (ser.series[key] || []).map(function (p) {
            return { t: p.t, v: p.avg, band: p.low == null ? null : [p.low, p.peak] };
          }),
        };
      }),
    });
  }

  function movingAvg(values, w) {
    return values.map(function (_, i) {
      var a = Math.max(0, i - w + 1), sum = 0, n = 0;
      for (var j = a; j <= i; j++) if (values[j] != null) { sum += values[j]; n++; }
      return n ? sum / n : null;
    });
  }

  function heatData(p) {
    if (!p) return { rows: DOW, cols: HOURS.map(hourLabel), cells: DOW.map(function () { return HOURS.map(function () { return null; }); }) };
    return {
      rows: DOW.map(function (d, i) { return DOW[(i + 1) % 7]; }),   // Mon-first
      cols: HOURS.map(function (h) { return (h < 10 ? '0' : '') + h; }),
      cells: [1, 2, 3, 4, 5, 6, 0].map(function (dow) {
        return HOURS.map(function (h) {
          var c = p.heatmap[dow][h];
          return c ? { v: c.avg, label: 'peak ' + fmt(c.peak) } : null;
        });
      }),
    };
  }

  // ------------------------------------------------------------- leaderboard
  var LB_COLS = [
    { id: 'name', label: 'Server', num: false },
    { id: 'now', label: 'Now' },
    { id: 'todayPeak', label: 'Today' },
    { id: 'peak', label: 'Peak' },
    { id: 'avg', label: 'Avg' },
    { id: 'low', label: 'Low' },
    { id: 'playerHours', label: 'Player-h' },
    { id: 'share', label: 'Share' },
    { id: 'uptime', label: 'Uptime' },
    { id: 'growth', label: 'Trend' },
    { id: 'allTimePeak', label: 'Record' },
  ];

  function renderLeaderboard(sum) {
    var rows = sum.rows.slice();
    var col = S.sort.col, dir = S.sort.dir;
    rows.sort(function (a, b) {
      var x = a[col], y = b[col];
      if (col === 'name') return dir * String(x || '').localeCompare(String(y || ''));
      x = x == null ? -Infinity : x;
      y = y == null ? -Infinity : y;
      return dir * (x - y);
    });
    var maxPeak = Math.max.apply(null, rows.map(function (s) { return s.peak || 0; }).concat([1]));

    var html = '<table class="data"><thead><tr>' + LB_COLS.map(function (c) {
      return '<th data-col="' + c.id + '" class="' + (c.num === false ? '' : 'num') + '">' + c.label +
        (S.sort.col === c.id ? '<span class="dir">' + (dir < 0 ? '↓' : '↑') + '</span>' : '') + '</th>';
    }).join('') + '<th class="num">30 samples</th></tr></thead><tbody>';

    rows.forEach(function (s) {
      html += '<tr data-key="' + esc(s.key) + '">' +
        '<td><div class="srv rowlink"><span class="dot ' + (s.online ? 'on' : '') + '"></span>' +
        '<span class="tag ' + esc(s.game) + '">' + esc(s.game) + '</span>' +
        '<span class="nm" title="' + esc(s.address || s.id) + '">' + esc(s.name) + '</span></div></td>' +
        '<td class="num">' + fmt(s.now) + '</td>' +
        '<td class="num">' + fmt(s.todayPeak) + '</td>' +
        '<td class="num">' + C.bullet(s.peak || 0, maxPeak, keyColor(s.key)) + ' ' + fmt(s.peak) + '</td>' +
        '<td class="num">' + fmt(s.avg, 1) + '</td>' +
        '<td class="num">' + fmt(s.low) + '</td>' +
        '<td class="num">' + fmt(s.playerHours, 0) + '</td>' +
        '<td class="num">' + (s.share == null ? '—' : s.share + '%') + '</td>' +
        '<td class="num">' + (s.uptime == null ? '—' : s.uptime + '%') + '</td>' +
        '<td class="num">' + delta(s.growth) + '</td>' +
        '<td class="num" title="' + (s.allTimePeakAt ? esc(C.fmtStamp(s.allTimePeakAt)) : '') + '">' + fmt(s.allTimePeak) + '</td>' +
        '<td class="num">' + C.sparkline(s.spark, 88, 20, keyColor(s.key)) + '</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById('lb').innerHTML = html;

    document.querySelectorAll('#lb th[data-col]').forEach(function (th) {
      th.addEventListener('click', function () {
        var c = th.getAttribute('data-col');
        if (S.sort.col === c) S.sort.dir *= -1;
        else S.sort = { col: c, dir: c === 'name' ? 1 : -1 };
        renderLeaderboard(sum);
      });
    });
    document.querySelectorAll('#lb tr[data-key]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        S.detail = tr.getAttribute('data-key');
        go();
      });
    });
  }

  // ----------------------------------------------------------------- SERVERS
  function renderServers() {
    var r = range();
    loading();
    api('summary', { days: r.days }).then(function (sum) {
      S.summary = sum;
      indexServers(sum.rows);
      var html = '<div class="panel"><h3>All tracked servers<span class="note">' + r.label +
        ' · click a row for details</span><span class="sp"></span>' +
        '<button class="linkbtn" id="csvlb">export CSV</button></h3><div class="tbl-wrap" id="lb"></div></div>';
      html += '<div class="grid3" id="cards"></div>';
      view().innerHTML = html;
      renderLeaderboard(sum);
      document.getElementById('csvlb').addEventListener('click', function () {
        location.href = '/api/stats/export.csv?type=leaderboard&days=' + r.days;
      });

      var cards = document.getElementById('cards');
      cards.innerHTML = sum.rows.map(function (s) {
        return '<div class="panel" style="margin:0"><h3><span class="dot ' + (s.online ? 'on' : '') + '"></span>' +
          '<span style="text-transform:none;letter-spacing:0;font-size:13px;color:#e6edf3;overflow:hidden;text-overflow:ellipsis">' +
          esc(s.name) + '</span></h3>' +
          '<div class="mini">' +
          '<div><div class="m-l">Now</div><div class="m-v">' + fmt(s.now) + '</div></div>' +
          '<div><div class="m-l">Peak</div><div class="m-v">' + fmt(s.peak) + '</div></div>' +
          '<div><div class="m-l">Avg</div><div class="m-v">' + fmt(s.avg, 1) + '</div></div>' +
          '</div><div style="margin-top:10px">' + C.sparkline(s.spark, 260, 40, keyColor(s.key)) + '</div>' +
          '<p class="hint2">' + esc(s.address || s.id) + ' · uptime ' + (s.uptime == null ? '—' : s.uptime + '%') +
          ' · <button class="linkbtn" data-open="' + esc(s.key) + '">open</button></p></div>';
      }).join('');
      cards.querySelectorAll('[data-open]').forEach(function (b) {
        b.addEventListener('click', function () {
          S.detail = b.getAttribute('data-open');
          go();
        });
      });
    }).catch(showError);
  }

  // ----------------------------------------------------------------- COMPARE
  function renderCompare() {
    var r = range();
    if (!S.sel.length) {
      S.sel = S.servers.slice(0, 4).map(function (s) { return s.key; });
    }
    var html = '<div class="panel"><h3>Pick servers to compare<span class="note">up to 8</span>' +
      '<span class="sp"></span><button class="linkbtn" id="selTop">top 5 by peak</button>' +
      ' · <button class="linkbtn" id="selNone">clear</button></h3><div class="picker" id="picker"></div></div>' +
      '<div id="cmp"></div>';
    view().innerHTML = html;
    renderPicker('picker', 8, renderCompareBody);
    document.getElementById('selTop').addEventListener('click', function () {
      var rows = (S.summary && S.summary.rows) || S.servers;
      S.sel = rows.slice().sort(function (a, b) { return (b.peak || 0) - (a.peak || 0); }).slice(0, 5)
        .map(function (s) { return s.key; });
      renderPicker('picker', 8, renderCompareBody);
      renderCompareBody();
    });
    document.getElementById('selNone').addEventListener('click', function () {
      S.sel = [];
      renderPicker('picker', 8, renderCompareBody);
      renderCompareBody();
    });
    renderCompareBody();
  }

  function renderPicker(id, max, onChange) {
    var host = document.getElementById(id);
    if (!host) return;
    var items = [{ key: ALL, name: 'All servers (total)', game: 'total' }].concat(S.servers);
    host.innerHTML = items.map(function (s) {
      var on = S.sel.indexOf(s.key) >= 0;
      return '<button class="pick' + (on ? ' on' : '') + '" data-k="' + esc(s.key) + '" style="--c:' + keyColor(s.key) + '">' +
        '<i></i><span class="nm">' + esc(s.name) + '</span></button>';
    }).join('');
    host.querySelectorAll('[data-k]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-k');
        var i = S.sel.indexOf(k);
        if (i >= 0) S.sel.splice(i, 1);
        else if (S.sel.length < max) S.sel.push(k);
        renderPicker(id, max, onChange);
        setHash();
        onChange();
      });
    });
  }

  function renderCompareBody() {
    disposeCharts(); // the picker re-renders this body without going through go()
    var host = document.getElementById('cmp');
    var r = range();
    if (!S.sel.length) {
      host.innerHTML = '<div class="panel"><div class="empty">Select one or more servers above.</div></div>';
      return;
    }
    host.innerHTML = '<div class="panel"><div class="empty">Loading…</div></div>';
    var keys = S.sel.join(',');
    Promise.all([
      api('series', { keys: keys, from: Date.now() - r.ms, to: Date.now(), points: 340 }),
      api('compare', { keys: keys, days: r.days }),
    ]).then(function (res) {
      var ser = res[0], cmp = res[1];
      var html = panel('Concurrent players', 'overlaid — click the legend to isolate', 'c-series',
        '<div class="seg" id="metricseg">' +
        '<button data-m="avg" class="on">Average</button><button data-m="peak">Peak</button>' +
        '<button data-m="norm">Normalised</button></div>');

      html += '<div class="panel"><h3>Head to head<span class="note">' + r.label + '</span></h3>' +
        '<div class="tbl-wrap" id="c-table"></div></div>';

      html += '<div class="grid2">' +
        panel('Hour of day', 'average players, local time', 'c-hour') +
        panel('Weekday', 'average players', 'c-dow') +
        '</div>';

      html += panel('Daily peak', 'per local day', 'c-daily');
      view().querySelector('#cmp').innerHTML = html;

      charts.cser = C.TimeChart(document.getElementById('c-series'), { height: 300, mode: 'line' });
      var applyMetric = function (m) {
        charts.cser.setData({
          from: ser.from, to: ser.to,
          series: S.sel.map(function (k) {
            var pts = ser.series[k] || [];
            var mx = 1;
            pts.forEach(function (p) { if (p.peak > mx) mx = p.peak; });
            return {
              key: k, name: name(k), color: keyColor(k),
              points: pts.map(function (p) {
                var v = m === 'peak' ? p.peak : m === 'norm' ? (p.avg == null ? null : (p.avg / mx) * 100) : p.avg;
                return { t: p.t, v: v };
              }),
            };
          }),
        });
      };
      applyMetric('avg');
      document.querySelectorAll('#metricseg button').forEach(function (b) {
        b.addEventListener('click', function () {
          document.querySelectorAll('#metricseg button').forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on');
          applyMetric(b.getAttribute('data-m'));
        });
      });

      // head-to-head table
      var METRICS = [
        ['Peak', function (m) { return fmt(m.peak); }],
        ['Average', function (m) { return fmt(m.avg, 1); }],
        ['Low', function (m) { return fmt(m.low); }],
        ['Player-hours', function (m) { return fmt(m.playerHours, 0); }],
        ['Uptime', function (m) { return m.uptime == null ? '—' : m.uptime + '%'; }],
        ['Busiest hour', function (m) { return m.bestHour == null ? '—' : hourLabel(m.bestHour) + ' (' + fmt(m.bestHourAvg, 1) + ')'; }],
        ['Busiest day', function (m) { return m.bestDow == null ? '—' : DOW_LONG[m.bestDow] + ' (' + fmt(m.bestDowAvg, 1) + ')'; }],
        ['Trend in range', function (m) { return delta(m.trend); }],
        ['Steadiness', function (m) { return m.consistency == null ? '—' : m.consistency + '/100'; }],
        ['All-time peak', function (m) { return fmt(m.allTimePeak) + (m.allTimePeakAt ? ' <span class="muted">· ' + esc(C.fmtDate(m.allTimePeakAt)) + '</span>' : ''); }],
        ['Best day', function (m) { return m.bestDay ? m.bestDay + ' (' + fmt(m.bestDayPeak) + ')' : '—'; }],
        ['Tracked since', function (m) { return m.firstSeen ? C.fmtDate(m.firstSeen) : '—'; }],
      ];
      var t = '<table class="data"><thead><tr><th>Metric</th>' + S.sel.map(function (k) {
        return '<th class="num"><span style="color:' + keyColor(k) + '">■</span> ' + esc(name(k)) + '</th>';
      }).join('') + '</tr></thead><tbody>';
      METRICS.forEach(function (row) {
        t += '<tr><td>' + row[0] + '</td>' + S.sel.map(function (k) {
          return '<td class="num">' + row[1](cmp.metrics[k] || {}) + '</td>';
        }).join('') + '</tr>';
      });
      t += '</tbody></table>';
      document.getElementById('c-table').innerHTML = t;

      charts.chour = C.CategoryChart(document.getElementById('c-hour'), { height: 210, mode: 'line' });
      charts.chour.setData({
        cats: HOURS.map(function (h) { return (h < 10 ? '0' : '') + h; }),
        catsLong: HOURS.map(hourLabel),
        series: S.sel.map(function (k) {
          var p = cmp.profiles[k];
          return {
            key: k, name: name(k), color: keyColor(k),
            values: HOURS.map(function (h) { return p && p.hourly[h] ? p.hourly[h].avg : null; }),
          };
        }),
      });

      charts.cdow = C.CategoryChart(document.getElementById('c-dow'), { height: 210, mode: 'bar' });
      charts.cdow.setData({
        cats: [1, 2, 3, 4, 5, 6, 0].map(function (d) { return DOW[d]; }),
        catsLong: [1, 2, 3, 4, 5, 6, 0].map(function (d) { return DOW_LONG[d]; }),
        series: S.sel.map(function (k) {
          var p = cmp.profiles[k];
          return {
            key: k, name: name(k), color: keyColor(k),
            values: [1, 2, 3, 4, 5, 6, 0].map(function (d) { return p && p.weekday[d] ? p.weekday[d].avg : null; }),
          };
        }),
      });

      charts.cdaily = C.CategoryChart(document.getElementById('c-daily'), { height: 220, mode: 'bar' });
      charts.cdaily.setData({
        cats: cmp.daily.days.map(function (d) { return d.slice(5); }),
        series: S.sel.map(function (k) {
          return {
            key: k, name: name(k), color: keyColor(k),
            values: (cmp.daily.byKey[k] || []).map(function (d) { return d.peak; }),
          };
        }),
      });
    }).catch(showError);
  }

  // ------------------------------------------------------------------- PEAKS
  function renderPeaks() {
    var r = range();
    // Peak times renders one heatmap per selection, so cap what Compare may
    // have carried over (it allows 8).
    S.sel = S.sel.slice(0, 4);
    if (!S.sel.length) S.sel = [ALL];
    var html = '<div class="panel"><h3>Peak-time analysis<span class="note">local time · day starts at ' + p2(DAY_START) + ':00</span>' +
      '</h3><div class="picker" id="picker2"></div>' +
      '<p class="hint2">Pick up to 4 servers. Cells show the average concurrent players for that weekday and hour ' +
      'over the selected range.</p></div><div id="pk"></div>';
    view().innerHTML = html;
    renderPicker('picker2', 4, renderPeaksBody);
    renderPeaksBody();
  }

  function renderPeaksBody() {
    disposeCharts();
    var host = document.getElementById('pk');
    var r = range();
    if (!S.sel.length) {
      host.innerHTML = '<div class="panel"><div class="empty">Select a server.</div></div>';
      return;
    }
    host.innerHTML = '<div class="panel"><div class="empty">Loading…</div></div>';
    api('profile', { keys: S.sel.join(','), days: Math.max(7, r.days) }).then(function (prof) {
      var html = '';
      S.sel.forEach(function (k, i) {
        html += panel(name(k), 'weekday × hour · avg concurrent players', 'hm-' + i);
      });
      html += '<div class="grid2">' +
        panel('Hour of day', 'average across the range', 'pk-hour') +
        panel('Weekday', 'average across the range', 'pk-dow') + '</div>';
      html += '<div class="panel"><h3>Best windows<span class="note">top hours by average</span></h3>' +
        '<div class="tbl-wrap" id="pk-top"></div></div>';
      host.innerHTML = html;

      S.sel.forEach(function (k, i) {
        var hm = C.Heatmap(document.getElementById('hm-' + i), { valueLabel: 'avg players' });
        hm.setData(heatData(prof.profiles[k]));
        charts['hm' + i] = hm;
      });

      charts.pkhour = C.CategoryChart(document.getElementById('pk-hour'), { height: 220, mode: 'line' });
      charts.pkhour.setData({
        cats: HOURS.map(function (h) { return (h < 10 ? '0' : '') + h; }),
        catsLong: HOURS.map(hourLabel),
        series: S.sel.map(function (k) {
          var p = prof.profiles[k];
          return {
            key: k, name: name(k), color: keyColor(k),
            values: HOURS.map(function (h) { return p && p.hourly[h] ? p.hourly[h].avg : null; }),
          };
        }),
      });
      charts.pkdow = C.CategoryChart(document.getElementById('pk-dow'), { height: 220, mode: 'bar' });
      charts.pkdow.setData({
        cats: [1, 2, 3, 4, 5, 6, 0].map(function (d) { return DOW[d]; }),
        catsLong: [1, 2, 3, 4, 5, 6, 0].map(function (d) { return DOW_LONG[d]; }),
        series: S.sel.map(function (k) {
          var p = prof.profiles[k];
          return {
            key: k, name: name(k), color: keyColor(k),
            values: [1, 2, 3, 4, 5, 6, 0].map(function (d) { return p && p.weekday[d] ? p.weekday[d].avg : null; }),
          };
        }),
      });

      // "best windows" — the 8 hottest weekday/hour cells per selection
      var t = '<table class="data"><thead><tr><th>Server</th><th>Window</th><th class="num">Avg players</th>' +
        '<th class="num">Peak seen</th><th class="num">vs its own average</th></tr></thead><tbody>';
      S.sel.forEach(function (k) {
        var p = prof.profiles[k];
        if (!p) return;
        var cells = [];
        var sum = 0, n = 0;
        for (var d = 0; d < 7; d++) {
          for (var h = 0; h < 24; h++) {
            var c = p.heatmap[d][h];
            if (!c) continue;
            cells.push({ d: d, h: h, v: c.avg, peak: c.peak });
            sum += c.avg;
            n++;
          }
        }
        var mean = n ? sum / n : 0;
        cells.sort(function (a, b) { return b.v - a.v; });
        cells.slice(0, 5).forEach(function (c, i) {
          t += '<tr><td>' + (i === 0 ? '<span style="color:' + keyColor(k) + '">■</span> ' + esc(name(k)) : '') + '</td>' +
            '<td>' + DOW_LONG[c.d] + ' ' + hourLabel(c.h) + '</td>' +
            '<td class="num">' + fmt(c.v, 1) + '</td><td class="num">' + fmt(c.peak) + '</td>' +
            '<td class="num">' + delta(mean ? ((c.v - mean) / mean) * 100 : null) + '</td></tr>';
        });
      });
      t += '</tbody></table>';
      document.getElementById('pk-top').innerHTML = t;
    }).catch(showError);
  }

  // ------------------------------------------------------------------ DETAIL
  function renderDetail() {
    var key = S.detail;
    var r = range();
    loading();
    Promise.all([
      api('series', { keys: key, from: Date.now() - r.ms, to: Date.now(), points: 360 }),
      api('compare', { keys: key, days: r.days }),
      api('daily', { keys: key, days: Math.min(120, Math.max(14, r.days)) }),
    ]).then(function (res) {
      var ser = res[0], cmp = res[1], day = res[2];
      var m = cmp.metrics[key] || {};
      var s = S.byKey[key] || { name: name(key), game: key.split(':')[0] };
      var prof = cmp.profiles[key];

      var html = '<div class="panel"><h3><button class="linkbtn" id="back">← back</button>' +
        '<span class="sp"></span></h3>' +
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:-6px 0 12px">' +
        '<span class="dot ' + (s.online ? 'on' : '') + '"></span>' +
        '<span style="font-size:19px;font-weight:650">' + esc(s.name) + '</span>' +
        '<span class="tag ' + esc(s.game) + '">' + esc(s.game) + '</span>' +
        '<span class="muted" style="font-size:12.5px">' + esc(s.address || '') + '</span>' +
        (s.maxSlots ? '<span class="muted" style="font-size:12.5px">· ' + s.maxSlots + ' slots</span>' : '') +
        '<span class="muted" style="font-size:12.5px">· last sample ' + ago(s.lastSampleAt) + '</span></div>' +
        '<div class="kpis" style="margin:0">' +
        kpi('Now', fmt(s.players), s.online ? 'online' : 'offline') +
        kpi('Today\'s peak', fmt(m.todayPeak)) +
        kpi(r.label + ' peak', fmt(m.peak), 'low ' + fmt(m.low)) +
        kpi(r.label + ' average', fmt(m.avg, 1), delta(m.trend) + ' within range') +
        kpi('Uptime', m.uptime == null ? '—' : m.uptime + '%', 'polled every minute') +
        kpi('Player-hours', fmt(m.playerHours, 0), 'over ' + r.label) +
        kpi('All-time peak', fmt(m.allTimePeak), m.allTimePeakAt ? C.fmtStamp(m.allTimePeakAt) : '—') +
        kpi('Capacity used', s.maxSlots && m.peak != null ? Math.round((m.peak / s.maxSlots) * 100) + '%' : '—',
          s.maxSlots ? 'peak vs ' + s.maxSlots + ' slots' : 'slot count unknown') +
        '</div></div>';

      html += panel('Concurrent players', 'line = average per bucket, band = min–max', 'd-series');
      html += '<div class="grid2">' +
        panel('Daily peak', 'dashed = 7-day average', 'd-daily') +
        panel('When players are online', 'weekday × hour, avg concurrent', 'd-heat') + '</div>';
      html += '<div class="grid2">' +
        panel('Hour of day', 'busiest hour: ' + (m.bestHour == null ? '—' : hourLabel(m.bestHour)), 'd-hour') +
        panel('Weekday', 'busiest day: ' + (m.bestDow == null ? '—' : DOW_LONG[m.bestDow]), 'd-dow') + '</div>';
      html += '<div class="panel"><h3>Daily breakdown<span class="sp"></span>' +
        '<button class="linkbtn" id="csvd">export CSV</button></h3><div class="tbl-wrap" id="d-table"></div></div>';

      view().innerHTML = html;
      document.getElementById('back').addEventListener('click', function () {
        S.detail = null;
        go();
      });
      document.getElementById('csvd').addEventListener('click', function () {
        location.href = '/api/stats/export.csv?type=daily&keys=' + encodeURIComponent(key) + '&days=' + Math.max(14, r.days);
      });

      charts.dser = C.TimeChart(document.getElementById('d-series'), { height: 290, mode: 'area' });
      charts.dser.setData({
        from: ser.from, to: ser.to,
        series: [{
          key: key, name: s.name, color: keyColor(key), band: true,
          points: (ser.series[key] || []).map(function (p) {
            return { t: p.t, v: p.avg, band: p.low == null ? null : [p.low, p.peak] };
          }),
        }],
      });

      var rows = day.byKey[key] || [];
      charts.ddaily = C.BarChart(document.getElementById('d-daily'), { height: 210, valueLabel: 'peak', color: keyColor(key) });
      charts.ddaily.setData({
        bars: rows.map(function (d) {
          return {
            label: d.day, short: d.day.slice(5).replace('-', '/'), value: d.peak || 0,
            sub: 'avg ' + fmt(d.avg, 1) + ' · ' + fmt(d.playerHours, 0) + ' player-h',
          };
        }),
        line: movingAvg(rows.map(function (d) { return d.peak; }), 7),
      });

      charts.dheat = C.Heatmap(document.getElementById('d-heat'), { valueLabel: 'avg players' });
      charts.dheat.setData(heatData(prof));

      charts.dhour = C.CategoryChart(document.getElementById('d-hour'), { height: 210, mode: 'line', highlight: m.bestHour == null ? -1 : HOURS.indexOf(m.bestHour) });
      charts.dhour.setData({
        cats: HOURS.map(function (h) { return (h < 10 ? '0' : '') + h; }),
        catsLong: HOURS.map(hourLabel),
        series: [{ key: key, name: s.name, color: keyColor(key), values: HOURS.map(function (h) { return prof && prof.hourly[h] ? prof.hourly[h].avg : null; }) }],
      });
      charts.ddow = C.CategoryChart(document.getElementById('d-dow'), { height: 210, mode: 'bar' });
      charts.ddow.setData({
        cats: [1, 2, 3, 4, 5, 6, 0].map(function (d) { return DOW[d]; }),
        catsLong: [1, 2, 3, 4, 5, 6, 0].map(function (d) { return DOW_LONG[d]; }),
        series: [{ key: key, name: s.name, color: keyColor(key), values: [1, 2, 3, 4, 5, 6, 0].map(function (d) { return prof && prof.weekday[d] ? prof.weekday[d].avg : null; }) }],
      });

      var t = '<table class="data"><thead><tr><th>Day</th><th>Weekday</th><th class="num">Peak</th>' +
        '<th class="num">Average</th><th class="num">Low</th><th class="num">Player-hours</th>' +
        '<th class="num">Uptime</th><th class="num">Samples</th></tr></thead><tbody>';
      var maxP = Math.max.apply(null, rows.map(function (d) { return d.peak || 0; }).concat([1]));
      rows.slice().reverse().forEach(function (d) {
        var wd = new Date(d.day + 'T12:00:00Z').getUTCDay();
        t += '<tr><td>' + d.day + '</td><td class="muted">' + DOW_LONG[wd] + '</td>' +
          '<td class="num">' + C.bullet(d.peak || 0, maxP, keyColor(key)) + ' ' + fmt(d.peak) + '</td>' +
          '<td class="num">' + fmt(d.avg, 1) + '</td><td class="num">' + fmt(d.low) + '</td>' +
          '<td class="num">' + fmt(d.playerHours, 0) + '</td>' +
          '<td class="num">' + (d.uptime == null ? '—' : d.uptime + '%') + '</td>' +
          '<td class="num muted">' + fmt(d.samples) + '</td></tr>';
      });
      t += '</tbody></table>';
      document.getElementById('d-table').innerHTML = t;
    }).catch(showError);
  }

  // -------------------------------------------------------------------- DATA
  function renderData() {
    var r = range();
    loading();
    api('health').then(function (h) {
      var html = '<div class="panel"><h3>Data health</h3><div class="mini">' +
        '<div><div class="m-l">Postgres</div><div class="m-v" style="color:' + (h.db.up ? '#3fb950' : '#f85149') + '">' +
        (h.db.enabled ? (h.db.up ? 'connected' : 'down') : 'disabled') + '</div></div>' +
        '<div><div class="m-l">Snapshot rows</div><div class="m-v">' + fmt(h.snapshots) + '</div></div>' +
        '<div><div class="m-l">Rollup rows</div><div class="m-v">' + fmt(h.hourly) + '</div></div>' +
        '<div><div class="m-l">History depth</div><div class="m-v">' + (h.historyDays == null ? '—' : h.historyDays + 'd') + '</div></div>' +
        '<div><div class="m-l">Local cache</div><div class="m-v">' + fmt(h.file.totalEntries) + '</div></div>' +
        '<div><div class="m-l">Last sample</div><div class="m-v" style="font-size:14px">' + ago(h.lastSampleAt) + '</div></div>' +
        '</div>' +
        (h.db.lastError ? '<p class="hint2">Last DB error: ' + esc(h.db.lastError) + '</p>' : '') +
        '<p class="hint2">Raw snapshots are kept ' + h.retention.snapshotDays + ' days at one sample per minute; ' +
        'the hourly rollup is kept ' + Math.round(h.retention.hourlyDays / 365) + ' years, so records and long-range ' +
        'trends survive the prune.</p></div>';

      html += '<div class="panel"><h3>Export</h3>' +
        '<p class="hint2" style="margin-bottom:10px">CSV exports use the current range (' + r.label + ') and local day boundaries.</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<a class="btn sec" href="/api/stats/export.csv?type=leaderboard&days=' + r.days + '">Leaderboard</a>' +
        '<a class="btn sec" href="/api/stats/export.csv?type=daily&days=' + r.days + '&keys=' + encodeURIComponent(allKeys()) + '">Daily per server</a>' +
        '<a class="btn sec" href="/api/stats/export.csv?type=hourly&days=' + Math.min(31, r.days) + '&keys=' + encodeURIComponent(allKeys()) + '">Hourly per server</a>' +
        '<a class="btn sec" href="/api/stats/export.csv?type=profile&days=' + r.days + '&keys=' + encodeURIComponent(allKeys()) + '">Weekday × hour</a>' +
        '</div></div>';

      html += '<div class="panel"><h3>Tracked servers<span class="note">from the servers config</span></h3>' +
        '<div class="tbl-wrap"><table class="data"><thead><tr><th>Server</th><th>Game</th><th>Address</th>' +
        '<th class="num">Slots</th><th class="num">First seen</th><th class="num">Last seen</th></tr></thead><tbody>' +
        S.servers.map(function (s) {
          return '<tr><td><div class="srv"><span class="dot ' + (s.online ? 'on' : '') + '"></span><span class="nm">' +
            esc(s.name) + '</span></div></td><td class="muted">' + esc(s.game) + '</td>' +
            '<td class="muted"><code>' + esc(s.address || s.id) + '</code></td>' +
            '<td class="num">' + (s.maxSlots || '—') + '</td>' +
            '<td class="num muted">' + (s.firstSeen ? C.fmtDate(s.firstSeen) : '—') + '</td>' +
            '<td class="num muted">' + ago(s.lastSeen) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';

      view().innerHTML = html;
    }).catch(showError);
  }

  function allKeys() {
    return S.servers.map(function (s) { return s.key; }).join(',');
  }

  // -------------------------------------------------------------------- boot
  function indexServers(rows) {
    if (rows) {
      S.servers = rows.map(function (r) { return r; });
    }
    S.byKey = {};
    S.servers.forEach(function (s) { S.byKey[s.key] = s; });
  }

  function showError(e) {
    if (e && e.message === 'auth') return;
    view().innerHTML = '<div class="panel"><div class="empty">Could not load stats: ' +
      esc(e && e.message ? e.message : String(e)) + '</div></div>';
  }

  function go() {
    disposeCharts();
    setHash();
    renderChrome();
    if (S.detail) return renderDetail();
    if (S.tab === 'servers') return renderServers();
    if (S.tab === 'compare') return renderCompare();
    if (S.tab === 'peaks') return renderPeaks();
    if (S.tab === 'data') return renderData();
    return renderOverview();
  }

  var refreshTimer = null;
  function scheduleRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(function () {
      if (document.hidden) return;
      // Only the live-ish views auto-refresh; drilldowns stay put.
      if (S.tab === 'overview' && !S.detail && !S.zoom) renderOverview();
      else if (S.tab === 'servers' && !S.detail) renderServers();
    }, 60000);
  }

  readHash();
  api('servers').then(function (r) {
    S.servers = r.servers;
    indexServers();
    go();
    scheduleRefresh();
  }).catch(function (e) {
    root.innerHTML = '<div class="panel"><div class="empty">Could not load servers: ' +
      esc(e && e.message ? e.message : e) + '</div></div>';
  });
})();
