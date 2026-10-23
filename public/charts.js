/* Chart primitives for the stats panel.
 *
 * Dependency-free SVG charts sized for dark UI: multi-series time lines/areas
 * (with crosshair, shared tooltip, legend toggling and drag-to-zoom), stacked
 * areas, bars, a weekday x hour heatmap, donuts, sparklines and bullet bars.
 *
 * Every chart re-renders from `chart.setData(...)` and resizes with its box, so
 * callers never touch the DOM they produce.
 */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  var PALETTE = [
    '#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff',
    '#39c5cf', '#ff7b72', '#7ee787', '#ffa657', '#79c0ff',
    '#db61a2', '#a5d6ff', '#56d364', '#e3b341', '#ff9492',
  ];

  function el(name, attrs, parent) {
    var e = document.createElementNS(NS, name);
    if (attrs) for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function div(cls, parent, html) {
    var d = document.createElement('div');
    if (cls) d.className = cls;
    if (html != null) d.innerHTML = html;
    if (parent) parent.appendChild(d);
    return d;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  function color(i) {
    return PALETTE[i % PALETTE.length];
  }
  function fmtNum(v, d) {
    if (v == null || isNaN(v)) return '—';
    if (d == null) d = Math.abs(v) < 10 && v % 1 !== 0 ? 1 : 0;
    return Number(v).toFixed(d).replace(/\.0$/, '');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // --- Community-time formatting (fixed UTC offset, injected by the page) ---
  var OFFSET = Number(global.UTC_OFFSET_MS) || 0;
  function ged(ms) {
    return new Date(ms + OFFSET);
  }
  function p2(n) {
    return (n < 10 ? '0' : '') + n;
  }
  function fmtTime(ms) {
    var d = ged(ms);
    return p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  }
  function fmtDate(ms) {
    var d = ged(ms);
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.getUTCDate();
  }
  function fmtStamp(ms) {
    return fmtDate(ms) + ' ' + fmtTime(ms);
  }

  function niceTicks(min, max, count) {
    if (min === max) {
      max = min + 1;
    }
    var span = max - min;
    var step = Math.pow(10, Math.floor(Math.log(span / count) / Math.LN10));
    var err = (span / count) / step;
    if (err >= 7.5) step *= 10;
    else if (err >= 3) step *= 5;
    else if (err >= 1.5) step *= 2;
    var out = [];
    for (var v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }

  function timeTicks(from, to, count) {
    var span = to - from;
    var steps = [
      60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3,
      12 * 3600e3, 864e5, 2 * 864e5, 7 * 864e5, 14 * 864e5, 30 * 864e5,
    ];
    var want = span / count, step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) if (steps[i] >= want) { step = steps[i]; break; }
    var out = [];
    // Align to the community wall clock, not UTC.
    var start = Math.ceil((from + OFFSET) / step) * step - OFFSET;
    for (var t = start; t <= to; t += step) out.push(t);
    return { ticks: out, step: step };
  }

  // ------------------------------------------------------------------ tooltip
  function makeTip(host) {
    var tip = div('ch-tip', host);
    tip.style.display = 'none';
    return {
      node: tip,
      show: function (html, x, y) {
        tip.innerHTML = html;
        tip.style.display = 'block';
        var w = host.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
        var left = x + 14;
        if (left + tw > w - 4) left = x - tw - 14;
        if (left < 4) left = 4;
        var top = y - th - 12;
        if (top < 4) top = y + 18;
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
      },
      hide: function () {
        tip.style.display = 'none';
      },
    };
  }

  // ------------------------------------------------------------- TimeChart
  /**
   * Multi-series time chart.
   * opts: { height, mode:'line'|'area'|'stack', yLabel, valueFmt, onZoom }
   * data: { from, to, series:[{key,name,color,points:[{t,v,band?:[lo,hi]}], dashed}] }
   */
  function TimeChart(host, opts) {
    opts = opts || {};
    var state = { data: null, hidden: {}, mode: opts.mode || 'line' };
    host.classList.add('ch');
    var wrap = div('ch-wrap', host);
    var svg = el('svg', { class: 'ch-svg' }, wrap);
    var legend = div('ch-legend', host);
    var tip = makeTip(wrap);
    var drag = null;
    // Rebuilt on every render and read by the window-level mouseup handler,
    // which is bound once (binding it inside render() would stack a new
    // listener on every resize and fire onZoom repeatedly).
    var live = null;

    var pad = { l: 46, r: 12, t: 10, b: 22 };

    function visible() {
      return (state.data ? state.data.series : []).filter(function (s) {
        return !state.hidden[s.key];
      });
    }

    function render() {
      clear(svg);
      if (!state.data) return;
      var W = wrap.clientWidth || 600;
      var H = opts.height || 260;
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('height', H);
      var d = state.data;
      var vis = visible();
      var iw = Math.max(10, W - pad.l - pad.r);
      var ih = Math.max(10, H - pad.t - pad.b);

      var stacked = state.mode === 'stack';
      var max = 0, min = 0;
      if (stacked) {
        var totals = {};
        vis.forEach(function (s) {
          s.points.forEach(function (p) {
            if (p.v == null) return;
            totals[p.t] = (totals[p.t] || 0) + p.v;
          });
        });
        for (var k in totals) if (totals[k] > max) max = totals[k];
      } else {
        vis.forEach(function (s) {
          s.points.forEach(function (p) {
            if (p.v != null && p.v > max) max = p.v;
            if (p.band && p.band[1] > max) max = p.band[1];
          });
        });
      }
      if (max <= 0) max = 1;
      max = max * 1.08;

      var x = function (t) {
        return pad.l + ((t - d.from) / Math.max(1, d.to - d.from)) * iw;
      };
      var y = function (v) {
        return pad.t + ih - ((v - min) / (max - min)) * ih;
      };

      // grid + axes
      var yt = niceTicks(min, max, Math.max(2, Math.round(ih / 42)));
      yt.forEach(function (v) {
        var yy = y(v);
        el('line', { x1: pad.l, x2: pad.l + iw, y1: yy, y2: yy, class: 'ch-grid' }, svg);
        var lbl = el('text', { x: pad.l - 7, y: yy + 4, class: 'ch-axis', 'text-anchor': 'end' }, svg);
        lbl.textContent = v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : fmtNum(v);
      });
      var tt = timeTicks(d.from, d.to, Math.max(2, Math.round(iw / 92)));
      var showDate = tt.step >= 6 * 3600e3;
      tt.ticks.forEach(function (t) {
        var xx = x(t);
        if (xx < pad.l - 1 || xx > pad.l + iw + 1) return;
        el('line', { x1: xx, x2: xx, y1: pad.t, y2: pad.t + ih, class: 'ch-grid ch-grid-v' }, svg);
        var lbl = el('text', { x: xx, y: H - 6, class: 'ch-axis', 'text-anchor': 'middle' }, svg);
        lbl.textContent = showDate ? fmtDate(t) : fmtTime(t);
      });

      // series
      var baseline = {};
      var order = stacked ? vis.slice().reverse() : vis;
      order.forEach(function (s, idx) {
        var c = s.color || color(d.series.indexOf(s));
        var pts = s.points.filter(function (p) {
          return p.v != null;
        });
        if (!pts.length) return;

        if (stacked) {
          var top = [], bot = [];
          pts.forEach(function (p) {
            var b = baseline[p.t] || 0;
            bot.push([x(p.t), y(b)]);
            baseline[p.t] = b + p.v;
            top.push([x(p.t), y(baseline[p.t])]);
          });
          var dstr = 'M' + top.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join('L') +
            'L' + bot.reverse().map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join('L') + 'Z';
          el('path', { d: dstr, fill: c, 'fill-opacity': 0.55, stroke: c, 'stroke-width': 1 }, svg);
          return;
        }

        if (s.band) {
          var up = [], dn = [];
          pts.forEach(function (p) {
            if (!p.band) return;
            up.push([x(p.t), y(p.band[1])]);
            dn.push([x(p.t), y(p.band[0])]);
          });
          if (up.length) {
            el('path', {
              d: 'M' + up.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join('L') +
                'L' + dn.reverse().map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join('L') + 'Z',
              fill: c, 'fill-opacity': 0.13, stroke: 'none',
            }, svg);
          }
        }

        var line = 'M' + pts.map(function (p) { return x(p.t).toFixed(1) + ',' + y(p.v).toFixed(1); }).join('L');
        if (state.mode === 'area') {
          el('path', {
            d: line + 'L' + x(pts[pts.length - 1].t).toFixed(1) + ',' + y(0) + 'L' + x(pts[0].t).toFixed(1) + ',' + y(0) + 'Z',
            fill: c, 'fill-opacity': 0.15, stroke: 'none',
          }, svg);
        }
        el('path', {
          d: line, fill: 'none', stroke: c, 'stroke-width': s.width || 1.8,
          'stroke-dasharray': s.dashed ? '4 3' : null,
          'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        }, svg);
      });

      if (!vis.length) {
        var t0 = el('text', { x: W / 2, y: H / 2, class: 'ch-empty', 'text-anchor': 'middle' }, svg);
        t0.textContent = 'no data in this range';
      }

      // interaction layer
      var cross = el('line', { class: 'ch-cross', y1: pad.t, y2: pad.t + ih, x1: -9, x2: -9 }, svg);
      var dots = el('g', {}, svg);
      var sel = el('rect', { class: 'ch-sel', x: 0, y: pad.t, height: ih, width: 0, visibility: 'hidden' }, svg);
      var hit = el('rect', { x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent', class: 'ch-hit' }, svg);

      function nearest(t) {
        var out = [];
        vis.forEach(function (s) {
          var best = null, bd = Infinity;
          for (var i = 0; i < s.points.length; i++) {
            var p = s.points[i];
            if (p.v == null) continue;
            var dd = Math.abs(p.t - t);
            if (dd < bd) { bd = dd; best = p; }
          }
          if (best && bd < (d.to - d.from) / 40) out.push({ s: s, p: best });
        });
        return out;
      }

      function toT(evt) {
        var r = svg.getBoundingClientRect();
        var px = ((evt.clientX - r.left) / r.width) * W;
        var frac = (px - pad.l) / iw;
        return d.from + Math.max(0, Math.min(1, frac)) * (d.to - d.from);
      }
      live = { toT: toT, sel: sel, span: d.to - d.from };

      hit.addEventListener('mousemove', function (e) {
        var t = toT(e);
        var hits = nearest(t);
        clear(dots);
        if (!hits.length) { tip.hide(); cross.setAttribute('x1', -9); cross.setAttribute('x2', -9); return; }
        var xx = x(hits[0].p.t);
        cross.setAttribute('x1', xx);
        cross.setAttribute('x2', xx);
        var html = '<div class="ch-tip-h">' + esc(fmtStamp(hits[0].p.t)) + '</div>';
        hits.sort(function (a, b) { return (b.p.v || 0) - (a.p.v || 0); });
        hits.forEach(function (h) {
          var c = h.s.color || color(d.series.indexOf(h.s));
          el('circle', { cx: x(h.p.t), cy: y(h.p.v), r: 3.5, fill: c, stroke: '#0d1117', 'stroke-width': 1.5 }, dots);
          html += '<div class="ch-tip-r"><i style="background:' + c + '"></i><span>' + esc(h.s.name) + '</span><b>' +
            (opts.valueFmt ? opts.valueFmt(h.p) : fmtNum(h.p.v)) + '</b></div>';
        });
        var r = svg.getBoundingClientRect();
        tip.show(html, e.clientX - r.left, e.clientY - r.top);

        if (drag) {
          var a = Math.min(drag.x0, xx), b = Math.max(drag.x0, xx);
          sel.setAttribute('x', a);
          sel.setAttribute('width', Math.max(0, b - a));
          sel.setAttribute('visibility', 'visible');
        }
      });
      hit.addEventListener('mouseleave', function () {
        tip.hide();
        clear(dots);
        cross.setAttribute('x1', -9);
        cross.setAttribute('x2', -9);
      });
      hit.addEventListener('mousedown', function (e) {
        drag = { x0: x(toT(e)), t0: toT(e) };
      });

      renderLegend();
    }

    function onMouseUp(e) {
      if (!drag || !live) return;
      var t1 = live.toT(e);
      var a = Math.min(drag.t0, t1), b = Math.max(drag.t0, t1);
      drag = null;
      live.sel.setAttribute('visibility', 'hidden');
      if (b - a > live.span / 60 && opts.onZoom) opts.onZoom(Math.round(a), Math.round(b));
    }
    window.addEventListener('mouseup', onMouseUp);

    function renderLegend() {
      clear(legend);
      if (!state.data || !state.data.series.length) return;
      state.data.series.forEach(function (s, i) {
        var c = s.color || color(i);
        var b = document.createElement('button');
        b.className = 'ch-leg' + (state.hidden[s.key] ? ' off' : '');
        b.innerHTML = '<i style="background:' + c + '"></i>' + esc(s.name);
        b.addEventListener('click', function () {
          state.hidden[s.key] = !state.hidden[s.key];
          render();
        });
        legend.appendChild(b);
      });
    }

    var ro = new ResizeObserver(function () { render(); });
    ro.observe(wrap);

    return {
      setData: function (d) { state.data = d; render(); },
      setMode: function (m) { state.mode = m; render(); },
      mode: function () { return state.mode; },
      only: function (keys) {
        state.hidden = {};
        if (keys) {
          (state.data ? state.data.series : []).forEach(function (s) {
            if (keys.indexOf(s.key) < 0) state.hidden[s.key] = true;
          });
        }
        render();
      },
      destroy: function () {
        ro.disconnect();
        window.removeEventListener('mouseup', onMouseUp);
      },
    };
  }

  // ---------------------------------------------------------------- BarChart
  /** data: { bars:[{label, value, sub, color}], valueFmt } */
  function BarChart(host, opts) {
    opts = opts || {};
    host.classList.add('ch');
    var wrap = div('ch-wrap', host);
    var svg = el('svg', { class: 'ch-svg' }, wrap);
    var tip = makeTip(wrap);
    var data = null;

    function render() {
      clear(svg);
      if (!data || !data.bars.length) return;
      var W = wrap.clientWidth || 600;
      var H = opts.height || 200;
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('height', H);
      var pad = { l: 40, r: 8, t: 10, b: 24 };
      var iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
      var max = 1;
      data.bars.forEach(function (b) { if (b.value > max) max = b.value; });
      max *= 1.1;
      var n = data.bars.length;
      var slot = iw / n, bw = Math.max(2, Math.min(38, slot * 0.68));

      niceTicks(0, max, Math.max(2, Math.round(ih / 40))).forEach(function (v) {
        var yy = pad.t + ih - (v / max) * ih;
        el('line', { x1: pad.l, x2: pad.l + iw, y1: yy, y2: yy, class: 'ch-grid' }, svg);
        var l = el('text', { x: pad.l - 7, y: yy + 4, class: 'ch-axis', 'text-anchor': 'end' }, svg);
        l.textContent = v >= 1000 ? (v / 1000).toFixed(1) + 'k' : fmtNum(v);
      });

      var every = Math.ceil(n / Math.max(1, Math.floor(iw / 54)));
      data.bars.forEach(function (b, i) {
        var h = Math.max(0, (b.value / max) * ih);
        var xx = pad.l + slot * i + (slot - bw) / 2;
        var yy = pad.t + ih - h;
        var rect = el('rect', {
          x: xx, y: yy, width: bw, height: h, rx: Math.min(3, bw / 2),
          fill: b.color || opts.color || '#58a6ff', 'fill-opacity': 0.85, class: 'ch-bar',
        }, svg);
        rect.addEventListener('mousemove', function (e) {
          var r = svg.getBoundingClientRect();
          tip.show('<div class="ch-tip-h">' + esc(b.label) + '</div><div class="ch-tip-r"><span>' +
            esc(opts.valueLabel || 'value') + '</span><b>' + fmtNum(b.value) + '</b></div>' +
            (b.sub ? '<div class="ch-tip-s">' + esc(b.sub) + '</div>' : ''),
            e.clientX - r.left, e.clientY - r.top);
        });
        rect.addEventListener('mouseleave', tip.hide);
        if (i % every === 0) {
          var l = el('text', { x: xx + bw / 2, y: H - 7, class: 'ch-axis', 'text-anchor': 'middle' }, svg);
          l.textContent = b.short || b.label;
        }
      });

      if (data.line && data.line.length === n) {
        var pts = [];
        data.line.forEach(function (v, i) {
          if (v == null) return;
          pts.push([pad.l + slot * i + slot / 2, pad.t + ih - (v / max) * ih]);
        });
        if (pts.length > 1) {
          el('path', {
            d: 'M' + pts.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join('L'),
            fill: 'none', stroke: '#d29922', 'stroke-width': 1.8, 'stroke-dasharray': '5 3',
          }, svg);
        }
      }
    }

    var ro = new ResizeObserver(render);
    ro.observe(wrap);
    return { setData: function (d) { data = d; render(); } };
  }

  // ----------------------------------------------------------- CategoryChart
  /**
   * Multi-series chart over labelled categories (hour-of-day, weekday, …).
   * data: { cats:[label], series:[{key,name,color,values:[n|null]}] }
   * opts: { height, mode:'line'|'bar', valueLabel, highlight:index }
   */
  function CategoryChart(host, opts) {
    opts = opts || {};
    host.classList.add('ch');
    var wrap = div('ch-wrap', host);
    var svg = el('svg', { class: 'ch-svg' }, wrap);
    var legend = div('ch-legend', host);
    var tip = makeTip(wrap);
    var data = null, hidden = {};

    function visible() {
      return (data ? data.series : []).filter(function (s) { return !hidden[s.key]; });
    }

    function render() {
      clear(svg);
      clear(legend);
      if (!data || !data.cats.length) return;
      var W = wrap.clientWidth || 600;
      var H = opts.height || 200;
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('height', H);
      var pad = { l: 40, r: 10, t: 10, b: 22 };
      var iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
      var vis = visible();
      var n = data.cats.length;
      var max = 1;
      vis.forEach(function (s) {
        s.values.forEach(function (v) { if (v != null && v > max) max = v; });
      });
      max *= 1.1;
      var slot = iw / n;
      var cx = function (i) { return pad.l + slot * (i + 0.5); };
      var cy = function (v) { return pad.t + ih - (v / max) * ih; };

      niceTicks(0, max, Math.max(2, Math.round(ih / 40))).forEach(function (v) {
        var yy = cy(v);
        el('line', { x1: pad.l, x2: pad.l + iw, y1: yy, y2: yy, class: 'ch-grid' }, svg);
        var l = el('text', { x: pad.l - 7, y: yy + 4, class: 'ch-axis', 'text-anchor': 'end' }, svg);
        l.textContent = v >= 1000 ? (v / 1000).toFixed(1) + 'k' : fmtNum(v);
      });

      if (opts.highlight != null && opts.highlight >= 0) {
        el('rect', {
          x: pad.l + slot * opts.highlight, y: pad.t, width: slot, height: ih,
          fill: '#58a6ff', 'fill-opacity': .07,
        }, svg);
      }

      var every = Math.ceil(n / Math.max(1, Math.floor(iw / 40)));
      data.cats.forEach(function (c, i) {
        if (i % every) return;
        var l = el('text', { x: cx(i), y: H - 6, class: 'ch-axis', 'text-anchor': 'middle' }, svg);
        l.textContent = c;
      });

      if (opts.mode === 'bar') {
        var bw = Math.max(2, (slot * 0.74) / Math.max(1, vis.length));
        vis.forEach(function (s, si) {
          var c = s.color || color(data.series.indexOf(s));
          s.values.forEach(function (v, i) {
            if (v == null) return;
            var h = Math.max(0, (v / max) * ih);
            el('rect', {
              x: pad.l + slot * i + (slot - bw * vis.length) / 2 + bw * si, y: pad.t + ih - h,
              width: bw, height: h, rx: Math.min(2, bw / 2), fill: c, 'fill-opacity': .85, class: 'ch-bar',
            }, svg);
          });
        });
      } else {
        vis.forEach(function (s) {
          var c = s.color || color(data.series.indexOf(s));
          var pts = [];
          s.values.forEach(function (v, i) { if (v != null) pts.push([cx(i), cy(v)]); });
          if (pts.length < 2) {
            pts.forEach(function (q) { el('circle', { cx: q[0], cy: q[1], r: 3, fill: c }, svg); });
            return;
          }
          var dstr = 'M' + pts.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join('L');
          if (opts.fill !== false && vis.length === 1) {
            el('path', {
              d: dstr + 'L' + pts[pts.length - 1][0].toFixed(1) + ',' + cy(0) + 'L' + pts[0][0].toFixed(1) + ',' + cy(0) + 'Z',
              fill: c, 'fill-opacity': .14, stroke: 'none',
            }, svg);
          }
          el('path', { d: dstr, fill: 'none', stroke: c, 'stroke-width': 1.9, 'stroke-linejoin': 'round' }, svg);
        });
      }

      // hover column
      var cross = el('rect', { class: 'ch-sel', x: -9, y: pad.t, width: slot, height: ih, visibility: 'hidden' }, svg);
      var hit = el('rect', { x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent', class: 'ch-hit' }, svg);
      hit.addEventListener('mousemove', function (e) {
        var r = svg.getBoundingClientRect();
        var px = ((e.clientX - r.left) / r.width) * W;
        var i = Math.max(0, Math.min(n - 1, Math.floor((px - pad.l) / slot)));
        cross.setAttribute('x', pad.l + slot * i);
        cross.setAttribute('visibility', 'visible');
        var html = '<div class="ch-tip-h">' + esc(data.catsLong ? data.catsLong[i] : data.cats[i]) + '</div>';
        var any = false;
        vis.slice().sort(function (a, b) { return (b.values[i] || 0) - (a.values[i] || 0); }).forEach(function (s) {
          var c = s.color || color(data.series.indexOf(s));
          html += '<div class="ch-tip-r"><i style="background:' + c + '"></i><span>' + esc(s.name) + '</span><b>' +
            (s.values[i] == null ? '—' : fmtNum(s.values[i], 1)) + '</b></div>';
          if (s.values[i] != null) any = true;
        });
        if (!any) html += '<div class="ch-tip-s">no data</div>';
        tip.show(html, e.clientX - r.left, e.clientY - r.top);
      });
      hit.addEventListener('mouseleave', function () {
        tip.hide();
        cross.setAttribute('visibility', 'hidden');
      });

      if (data.series.length > 1) {
        data.series.forEach(function (s, i) {
          var c = s.color || color(i);
          var b = document.createElement('button');
          b.className = 'ch-leg' + (hidden[s.key] ? ' off' : '');
          b.innerHTML = '<i style="background:' + c + '"></i>' + esc(s.name);
          b.addEventListener('click', function () {
            hidden[s.key] = !hidden[s.key];
            render();
          });
          legend.appendChild(b);
        });
      }
    }

    var ro = new ResizeObserver(render);
    ro.observe(wrap);
    return {
      setData: function (d) { data = d; render(); },
      setMode: function (m) { opts.mode = m; render(); },
    };
  }

  // ----------------------------------------------------------------- Heatmap
  /**
   * Weekday x hour grid. data: { rows:[label], cols:[label], cells:[[{v,label}|null]] }
   * Colour ramp runs dark-navy -> blue -> green -> amber so hot cells pop.
   */
  function Heatmap(host, opts) {
    opts = opts || {};
    host.classList.add('ch');
    var wrap = div('ch-wrap ch-heat', host);
    var svg = el('svg', { class: 'ch-svg' }, wrap);
    var tip = makeTip(wrap);
    var data = null;

    var RAMP = [
      [13, 17, 23], [22, 45, 77], [31, 81, 130], [46, 125, 165],
      [56, 160, 130], [86, 190, 90], [190, 190, 70], [230, 150, 50], [240, 90, 70],
    ];
    function ramp(f) {
      f = Math.max(0, Math.min(1, f));
      var x = f * (RAMP.length - 1);
      var i = Math.floor(x), t = x - i;
      var a = RAMP[i], b = RAMP[Math.min(RAMP.length - 1, i + 1)];
      return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' + Math.round(a[1] + (b[1] - a[1]) * t) + ',' +
        Math.round(a[2] + (b[2] - a[2]) * t) + ')';
    }

    function render() {
      clear(svg);
      if (!data) return;
      var W = wrap.clientWidth || 600;
      var padL = 34, padT = 16, padB = 4, padR = 4;
      var cols = data.cols.length, rows = data.rows.length;
      var cw = (W - padL - padR) / cols;
      var chh = opts.cell || Math.max(15, Math.min(26, cw));
      var H = padT + rows * chh + padB;
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('height', H);

      var max = 0;
      data.cells.forEach(function (r) {
        r.forEach(function (c) { if (c && c.v > max) max = c.v; });
      });
      if (!max) max = 1;

      data.cols.forEach(function (c, i) {
        if (cols > 14 && i % 2) return;
        var l = el('text', { x: padL + cw * (i + 0.5), y: 11, class: 'ch-axis', 'text-anchor': 'middle' }, svg);
        l.textContent = c;
      });
      data.rows.forEach(function (r, i) {
        var l = el('text', { x: padL - 6, y: padT + chh * (i + 0.5) + 4, class: 'ch-axis', 'text-anchor': 'end' }, svg);
        l.textContent = r;
      });

      for (var ri = 0; ri < rows; ri++) {
        for (var ci = 0; ci < cols; ci++) {
          var cell = data.cells[ri][ci];
          var rect = el('rect', {
            x: padL + cw * ci + 0.6, y: padT + chh * ri + 0.6,
            width: Math.max(1, cw - 1.2), height: Math.max(1, chh - 1.2), rx: 2,
            fill: cell ? ramp(cell.v / max) : '#11151c',
            stroke: cell ? 'none' : '#161b22',
            class: 'ch-cell',
          }, svg);
          (function (cell, ri, ci) {
            rect.addEventListener('mousemove', function (e) {
              var r = svg.getBoundingClientRect();
              tip.show('<div class="ch-tip-h">' + esc(data.rows[ri] + ' · ' + data.cols[ci]) + '</div>' +
                (cell ? '<div class="ch-tip-r"><span>' + esc(opts.valueLabel || 'avg') + '</span><b>' + fmtNum(cell.v, 1) + '</b></div>' +
                  (cell.label ? '<div class="ch-tip-s">' + esc(cell.label) + '</div>' : '')
                  : '<div class="ch-tip-s">no data</div>'),
                e.clientX - r.left, e.clientY - r.top);
            });
            rect.addEventListener('mouseleave', tip.hide);
          })(cell, ri, ci);
        }
      }
    }

    var ro = new ResizeObserver(render);
    ro.observe(wrap);
    return { setData: function (d) { data = d; render(); } };
  }

  // ------------------------------------------------------------------- Donut
  /** data: [{label, value, color}] */
  function Donut(host, opts) {
    opts = opts || {};
    host.classList.add('ch');
    var wrap = div('ch-wrap ch-donut', host);
    var svg = el('svg', { class: 'ch-svg' }, wrap);
    var tip = makeTip(wrap);
    var data = null;

    function render() {
      clear(svg);
      if (!data || !data.length) return;
      var W = wrap.clientWidth || 260;
      var H = opts.height || 200;
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('height', H);
      var cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 6, r = R * 0.62;
      var total = data.reduce(function (a, b) { return a + (b.value || 0); }, 0);
      if (!total) return;
      var ang = -Math.PI / 2;
      data.forEach(function (d, i) {
        var frac = (d.value || 0) / total;
        var a2 = ang + frac * Math.PI * 2;
        var large = frac > 0.5 ? 1 : 0;
        var path = 'M' + (cx + R * Math.cos(ang)) + ',' + (cy + R * Math.sin(ang)) +
          'A' + R + ',' + R + ' 0 ' + large + ' 1 ' + (cx + R * Math.cos(a2)) + ',' + (cy + R * Math.sin(a2)) +
          'L' + (cx + r * Math.cos(a2)) + ',' + (cy + r * Math.sin(a2)) +
          'A' + r + ',' + r + ' 0 ' + large + ' 0 ' + (cx + r * Math.cos(ang)) + ',' + (cy + r * Math.sin(ang)) + 'Z';
        var p = el('path', { d: path, fill: d.color || color(i), 'fill-opacity': 0.88, class: 'ch-slice' }, svg);
        (function (d, frac) {
          p.addEventListener('mousemove', function (e) {
            var rr = svg.getBoundingClientRect();
            tip.show('<div class="ch-tip-h">' + esc(d.label) + '</div><div class="ch-tip-r"><span>share</span><b>' +
              (frac * 100).toFixed(1) + '%</b></div><div class="ch-tip-s">' + fmtNum(d.value, 1) + ' ' + esc(opts.unit || '') + '</div>',
              e.clientX - rr.left, e.clientY - rr.top);
          });
          p.addEventListener('mouseleave', tip.hide);
        })(d, frac);
        ang = a2;
      });
      if (opts.center) {
        var t1 = el('text', { x: cx, y: cy - 2, class: 'ch-c1', 'text-anchor': 'middle' }, svg);
        t1.textContent = opts.center;
        var t2 = el('text', { x: cx, y: cy + 14, class: 'ch-c2', 'text-anchor': 'middle' }, svg);
        t2.textContent = opts.centerSub || '';
      }
    }

    var ro = new ResizeObserver(render);
    ro.observe(wrap);
    return { setData: function (d) { data = d; render(); } };
  }

  // --------------------------------------------------------------- sparkline
  function sparkline(values, w, h, stroke) {
    w = w || 90;
    h = h || 22;
    var vals = (values || []).filter(function (v) { return v != null; });
    if (vals.length < 2) return '';
    var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
    if (max === min) max = min + 1;
    var step = w / (vals.length - 1);
    var pts = vals.map(function (v, i) {
      return (i * step).toFixed(1) + ',' + (h - 1 - ((v - min) / (max - min)) * (h - 2)).toFixed(1);
    });
    var c = stroke || '#58a6ff';
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<path d="M' + pts.join('L') + 'L' + w + ',' + h + 'L0,' + h + 'Z" fill="' + c + '" fill-opacity=".12"/>' +
      '<path d="M' + pts.join('L') + '" fill="none" stroke="' + c + '" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  }

  /** Inline proportional bar for table cells. */
  function bullet(value, max, c) {
    var pct = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    return '<span class="bullet"><i style="width:' + pct.toFixed(1) + '%;background:' + (c || '#58a6ff') + '"></i></span>';
  }

  global.Charts = {
    TimeChart: TimeChart,
    BarChart: BarChart,
    CategoryChart: CategoryChart,
    Heatmap: Heatmap,
    Donut: Donut,
    sparkline: sparkline,
    bullet: bullet,
    color: color,
    palette: PALETTE,
    fmtNum: fmtNum,
    fmtTime: fmtTime,
    fmtDate: fmtDate,
    fmtStamp: fmtStamp,
    esc: esc,
  };
})(window);
