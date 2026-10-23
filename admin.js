'use strict';

/**
 * Express admin web panel + public /healthz endpoint.
 *
 * Auth: a single ADMIN_KEY gates the panel via a signed session cookie
 * (HMAC of an issue timestamp). No secrets are ever logged. /healthz is public
 * so a platform healthcheck works regardless of auth/DB state.
 *
 * Hardening: per-IP login throttling, same-origin check on every state-changing
 * request (CSRF), anti-framing / nosniff headers, image-only asset uploads.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const card = require('./card');
const analytics = require('./analytics');
const adminStats = require('./admin-stats');
const { COMMUNITY_NAME } = require('./config');

const COOKIE = 'panel_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ASSET_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Login throttling: at most LOGIN_MAX failed attempts per IP per window.
// ponytail: in-memory, per-process; use a shared store if you run replicas.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 10;
const loginFails = new Map(); // ip -> { n, until }
function loginBlocked(ip) {
  const e = loginFails.get(ip);
  if (!e) return false;
  if (Date.now() > e.until) {
    loginFails.delete(ip);
    return false;
  }
  return e.n >= LOGIN_MAX;
}
function noteLoginFail(ip) {
  const now = Date.now();
  const e = loginFails.get(ip);
  if (!e || now > e.until) loginFails.set(ip, { n: 1, until: now + LOGIN_WINDOW_MS });
  else e.n++;
  if (loginFails.size > 10000) loginFails.clear(); // bound memory under a spray
}

function sessionSecret() {
  // Bind the signing secret to ADMIN_KEY (and an optional SESSION_EPOCH) so that
  // rotating the admin key - or bumping SESSION_EPOCH - revokes every existing
  // session, even when SESSION_SECRET is explicitly set.
  return crypto
    .createHash('sha256')
    .update(`${process.env.SESSION_SECRET || ''}|${process.env.ADMIN_KEY || ''}|${process.env.SESSION_EPOCH || ''}`)
    .digest('hex');
}
function sign(ts) {
  return crypto.createHmac('sha256', sessionSecret()).update(String(ts)).digest('hex');
}
function makeToken() {
  const ts = Date.now();
  return `${ts}.${sign(ts)}`;
}
function verifyToken(tok) {
  if (!tok || !process.env.ADMIN_KEY) return false;
  const [ts, sig] = String(tok).split('.');
  if (!ts || !sig) return false;
  const expected = sign(ts);
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const age = Date.now() - Number(ts);
  return age >= 0 && age < SESSION_TTL_MS;
}
function keyMatches(input) {
  if (!process.env.ADMIN_KEY) return false;
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(String(process.env.ADMIN_KEY)).digest();
  return crypto.timingSafeEqual(a, b);
}
function getCookie(req, name) {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const part of h.split(';')) {
    const idx = part.indexOf('=');
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function bytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

const WELCOME_VARS = [
  '${usermention}', '${username}', '${usertag}', '${userglobalnickname}', '${usernickname}',
  '${userdisplayname}', '${userid}', '${useravatarurl}', '${userserveravatarurl}',
  '${usercreatedat}', '${userjoinedat}', '${guildname}', '${guildmembercount}',
  '${guildiconurl}', '${guildbannerurl}', '${guildvanitycode}', '${nowtimestamp}',
];

function channelOptionsHtml(channels, selected) {
  const opts = ['<option value="">— none —</option>'];
  for (const c of channels) {
    opts.push(`<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>#${esc(c.name)}</option>`);
  }
  return opts.join('');
}

function roleChecksHtml(roles, selectedArr) {
  const sel = new Set(selectedArr || []);
  if (!roles.length) return '<p class="hint">No assignable roles.</p>';
  return (
    '<div class="checks">' +
    roles
      .map(
        (r) =>
          `<label class="chk"><input type="checkbox" name="auto_roles" value="${esc(r.id)}" ${sel.has(r.id) ? 'checked' : ''}> ${esc(r.name)}</label>`
      )
      .join('') +
    '</div>'
  );
}

// Click-to-insert variable chips + a tiny script that drops the variable into
// the last-focused text field. Keeps admins from memorising ${...} tokens.
function varChipsHtml() {
  const chips = WELCOME_VARS.map((v) => `<button type="button" class="chip" data-v="${esc(v)}">${esc(v)}</button>`).join('');
  return `<div class="card"><h2>Variables — click to insert</h2><div class="chips">${chips}</div>
    <p class="hint">Click a field, then a chip, to insert it. \`…at\` render as Discord timestamps.</p></div>
    <script>(function(){var last=null;
      document.addEventListener('focusin',function(e){var t=e.target;if(t&&(t.tagName==='TEXTAREA'||(t.tagName==='INPUT'&&(!t.type||t.type==='text'))))last=t;});
      document.querySelectorAll('.chip').forEach(function(b){b.addEventListener('click',function(){var el=last;if(!el)return;var v=b.getAttribute('data-v');var s=el.selectionStart==null?el.value.length:el.selectionStart,e=el.selectionEnd==null?el.value.length:el.selectionEnd;el.value=el.value.slice(0,s)+v+el.value.slice(e);el.focus();var p=s+v.length;try{el.setSelectionRange(p,p);}catch(_){}});});
    })();</script>`;
}

// Server-side validation/clamping of a card document.
function sanitizeCard(input) {
  const c = input && typeof input === 'object' ? input : {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const out = {
    enabled: !!c.enabled,
    width: Math.max(200, Math.min(2000, Math.round(num(c.width, 1000)))),
    height: Math.max(100, Math.min(1200, Math.round(num(c.height, 300)))),
    background: null,
    attach: { dm: !!(c.attach && c.attach.dm), channel: !!(c.attach && c.attach.channel) },
    layers: [],
  };
  const bg = c.background;
  if (bg && bg.type === 'color' && typeof bg.color === 'string') out.background = { type: 'color', color: bg.color.slice(0, 9) };
  else if (bg && bg.type === 'image' && typeof bg.assetId === 'string') out.background = { type: 'image', assetId: bg.assetId.slice(0, 64) };
  const layers = Array.isArray(c.layers) ? c.layers.slice(0, 30) : [];
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    if (l.type === 'text') {
      out.layers.push({
        type: 'text', text: String(l.text || '').slice(0, 500),
        x: Math.round(num(l.x, 0)), y: Math.round(num(l.y, 0)),
        size: Math.max(6, Math.min(400, Math.round(num(l.size, 32)))),
        color: String(l.color || '#ffffff').slice(0, 9),
        weight: l.weight === 'bold' ? 'bold' : 'normal',
        align: ['left', 'center', 'right'].includes(l.align) ? l.align : 'left',
      });
    } else if (l.type === 'avatar') {
      out.layers.push({ type: 'avatar', x: Math.round(num(l.x, 0)), y: Math.round(num(l.y, 0)), size: Math.max(8, Math.min(1200, Math.round(num(l.size, 128)))), round: l.round !== false });
    } else if (l.type === 'image') {
      out.layers.push({ type: 'image', assetId: String(l.assetId || '').slice(0, 64), x: Math.round(num(l.x, 0)), y: Math.round(num(l.y, 0)), w: Math.max(8, Math.min(2000, Math.round(num(l.w, 128)))), h: Math.max(8, Math.min(1200, Math.round(num(l.h, 128)))), round: !!l.round });
    }
  }
  return out;
}

// Browser-side card editor. Written WITHOUT template literals so its source can
// be injected via .toString() into the server template without interpolation.
function cardEditorClient() {
  var doc = window.__CARD__ || {};
  var G = window.__G__;
  if (!doc.layers) doc.layers = [];
  if (!doc.background) doc.background = { type: 'color', color: '#1e2230' };
  if (!doc.attach) doc.attach = {};
  doc.width = doc.width || 1000; doc.height = doc.height || 300;
  var sel = -1, drag = null, imgs = {};
  var cv = document.getElementById('cv'), ctx = cv.getContext('2d');
  var SAMPLE = { username: 'Player', usermention: '@Player', userdisplayname: 'Player', userglobalnickname: 'Player', usertag: 'player', guildname: 'Server', guildmembercount: '128', userjoinedat: 'today', usercreatedat: '2020' };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function assetUrl(id) { return '/welcome/' + G + '/asset/' + id; }
  function sample(t) { return String(t || '').replace(/\$\{(\w+)\}/g, function (m, k) { return SAMPLE[k] != null ? SAMPLE[k] : m; }); }
  function getImg(src) { if (!imgs[src]) { var im = new Image(); im.onload = draw; im.onerror = function () {}; im.src = src; imgs[src] = im; } return imgs[src]; }
  function ready(im) { return im && im.complete && im.naturalWidth; }
  function cover(im, x, y, w, h) { var ir = im.width / im.height, r = w / h, sw = im.width, sh = im.height, sx = 0, sy = 0; if (ir > r) { sw = im.height * r; sx = (im.width - sw) / 2; } else { sh = im.width / r; sy = (im.height - sh) / 2; } ctx.drawImage(im, sx, sy, sw, sh, x, y, w, h); }
  function circle(x, y, w, h, fn) { ctx.save(); ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, 6.2832); ctx.clip(); fn(); ctx.restore(); }
  function bbox(l) { if (l.type === 'text') { ctx.font = (l.weight === 'bold' ? 'bold ' : '') + (l.size || 32) + 'px sans-serif'; var w = ctx.measureText(sample(l.text)).width; var x = l.x; if (l.align === 'center') x -= w / 2; else if (l.align === 'right') x -= w; return { x: x, y: l.y, w: w, h: (l.size || 32) * 1.2 }; } if (l.type === 'avatar') return { x: l.x, y: l.y, w: l.size || 128, h: l.size || 128 }; return { x: l.x, y: l.y, w: l.w || 128, h: l.h || 128 }; }
  function drawLayer(l) {
    if (l.type === 'text') { ctx.font = (l.weight === 'bold' ? 'bold ' : '') + (l.size || 32) + 'px sans-serif'; ctx.fillStyle = l.color || '#fff'; ctx.textBaseline = 'top'; ctx.textAlign = l.align || 'left'; ctx.fillText(sample(l.text), l.x, l.y); ctx.textAlign = 'left'; }
    else if (l.type === 'avatar') { var im = getImg('https://cdn.discordapp.com/embed/avatars/0.png'); var s = l.size || 128; if (ready(im)) { if (l.round) circle(l.x, l.y, s, s, function () { cover(im, l.x, l.y, s, s); }); else cover(im, l.x, l.y, s, s); } else { ctx.fillStyle = '#30363d'; ctx.beginPath(); ctx.arc(l.x + s / 2, l.y + s / 2, s / 2, 0, 6.2832); ctx.fill(); } }
    else if (l.type === 'image') { var im2 = getImg(assetUrl(l.assetId)); var w = l.w || 128, h = l.h || 128; if (ready(im2)) { if (l.round) circle(l.x, l.y, w, h, function () { cover(im2, l.x, l.y, w, h); }); else ctx.drawImage(im2, l.x, l.y, w, h); } else { ctx.fillStyle = '#21262d'; ctx.fillRect(l.x, l.y, w, h); } }
  }
  function draw() {
    cv.width = doc.width; cv.height = doc.height;
    if (doc.background.type === 'image' && doc.background.assetId) { var im = getImg(assetUrl(doc.background.assetId)); if (ready(im)) cover(im, 0, 0, doc.width, doc.height); else { ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, doc.width, doc.height); } }
    else { ctx.fillStyle = doc.background.color || '#1e2230'; ctx.fillRect(0, 0, doc.width, doc.height); }
    for (var i = 0; i < doc.layers.length; i++) drawLayer(doc.layers[i]);
    if (sel >= 0 && doc.layers[sel]) { var b = bbox(doc.layers[sel]); ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 2; ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4); }
    layerList(); props();
  }
  function layerList() {
    var h = '';
    for (var i = 0; i < doc.layers.length; i++) { var l = doc.layers[i]; var nm = l.type === 'text' ? ('T: ' + sample(l.text).slice(0, 16)) : (l.type === 'avatar' ? 'Avatar' : 'Image'); h += '<div class="lyr' + (i === sel ? ' selsel' : '') + '" data-i="' + i + '"><span class="lname">' + esc(nm) + '</span><span><button type="button" data-act="up" data-i="' + i + '">↑</button><button type="button" data-act="down" data-i="' + i + '">↓</button><button type="button" data-act="del" data-i="' + i + '">✕</button></span></div>'; }
    document.getElementById('layers').innerHTML = h || '<p class="hint">No layers yet - add text, an avatar, or an image.</p>';
  }
  function opt(cur, arr) { var h = ''; for (var i = 0; i < arr.length; i++) h += '<option' + (cur === arr[i] ? ' selected' : '') + '>' + arr[i] + '</option>'; return h; }
  function props() {
    var el = document.getElementById('props'); if (sel < 0 || !doc.layers[sel]) { el.innerHTML = ''; return; }
    var l = doc.layers[sel];
    function inp(lbl, k, t) { return '<label>' + lbl + '</label><input data-k="' + k + '" type="' + (t || 'text') + '" value="' + esc(l[k] != null ? l[k] : '') + '">'; }
    var h = '<h3>Properties</h3>';
    if (l.type === 'text') h += inp('Text', 'text') + '<div class="row"><div>' + inp('X', 'x', 'number') + '</div><div>' + inp('Y', 'y', 'number') + '</div><div>' + inp('Size', 'size', 'number') + '</div></div><div class="row"><div><label>Color</label><input data-k="color" type="color" value="' + esc(l.color || '#ffffff') + '"></div><div><label>Weight</label><select data-k="weight">' + opt(l.weight, ['normal', 'bold']) + '</select></div><div><label>Align</label><select data-k="align">' + opt(l.align || 'left', ['left', 'center', 'right']) + '</select></div></div>';
    else if (l.type === 'avatar') h += '<div class="row"><div>' + inp('X', 'x', 'number') + '</div><div>' + inp('Y', 'y', 'number') + '</div><div>' + inp('Size', 'size', 'number') + '</div></div><label class="chk"><input data-k="round" type="checkbox"' + (l.round !== false ? ' checked' : '') + '> Circular</label>';
    else h += '<div class="row"><div>' + inp('X', 'x', 'number') + '</div><div>' + inp('Y', 'y', 'number') + '</div></div><div class="row"><div>' + inp('W', 'w', 'number') + '</div><div>' + inp('H', 'h', 'number') + '</div></div><label class="chk"><input data-k="round" type="checkbox"' + (l.round ? ' checked' : '') + '> Circular</label>';
    el.innerHTML = h;
    el.querySelectorAll('[data-k]').forEach(function (e) { var ev = function () { var k = e.getAttribute('data-k'); var v = e.type === 'checkbox' ? e.checked : (e.type === 'number' ? (parseFloat(e.value) || 0) : e.value); doc.layers[sel][k] = v; draw(); }; e.addEventListener('input', ev); e.addEventListener('change', ev); });
  }
  function pos(e) { var r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) }; }
  cv.addEventListener('mousedown', function (e) { var p = pos(e); for (var i = doc.layers.length - 1; i >= 0; i--) { var b = bbox(doc.layers[i]); if (p.x >= b.x - 3 && p.x <= b.x + b.w + 3 && p.y >= b.y - 3 && p.y <= b.y + b.h + 3) { sel = i; drag = { dx: p.x - doc.layers[i].x, dy: p.y - doc.layers[i].y }; draw(); return; } } sel = -1; draw(); });
  window.addEventListener('mousemove', function (e) { if (!drag || sel < 0) return; var p = pos(e); doc.layers[sel].x = Math.round(p.x - drag.dx); doc.layers[sel].y = Math.round(p.y - drag.dy); draw(); });
  window.addEventListener('mouseup', function () { drag = null; });
  document.getElementById('layers').addEventListener('click', function (e) { var t = e.target; var act = t.getAttribute('data-act'); if (act) { var i = parseInt(t.getAttribute('data-i'), 10); if (act === 'del') { doc.layers.splice(i, 1); sel = -1; } else if (act === 'up' && i > 0) { var a = doc.layers[i - 1]; doc.layers[i - 1] = doc.layers[i]; doc.layers[i] = a; sel = i - 1; } else if (act === 'down' && i < doc.layers.length - 1) { var b = doc.layers[i + 1]; doc.layers[i + 1] = doc.layers[i]; doc.layers[i] = b; sel = i + 1; } draw(); return; } var row = t.closest ? t.closest('.lyr') : null; if (row) { sel = parseInt(row.getAttribute('data-i'), 10); draw(); } });
  function upload(file, cb) { if (!file) return; if (file.size > 4 * 1024 * 1024) { alert('Image too large (max 4MB).'); return; } var fr = new FileReader(); fr.onload = function () { fetch('/welcome/' + G + '/asset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl: fr.result }) }).then(function (r) { return r.json(); }).then(function (j) { if (j && j.id) cb(j.id); else alert('Upload failed.'); }).catch(function () { alert('Upload failed.'); }); }; fr.readAsDataURL(file); }
  function bind(id, ev, fn) { var e = document.getElementById(id); if (e) e.addEventListener(ev, fn); }
  document.getElementById('enabled').checked = !!doc.enabled;
  bind('enabled', 'change', function (e) { doc.enabled = e.target.checked; });
  var cw = document.getElementById('cardw'); cw.value = doc.width; bind('cardw', 'input', function () { doc.width = Math.max(200, Math.min(2000, parseInt(cw.value, 10) || 1000)); draw(); });
  var chh = document.getElementById('cardh'); chh.value = doc.height; bind('cardh', 'input', function () { doc.height = Math.max(100, Math.min(1200, parseInt(chh.value, 10) || 300)); draw(); });
  var bgc = document.getElementById('bgcolor'); bgc.value = (doc.background.type === 'color' && doc.background.color) || '#1e2230'; bind('bgcolor', 'input', function () { doc.background = { type: 'color', color: bgc.value }; draw(); });
  document.getElementById('atdm').checked = !!doc.attach.dm; bind('atdm', 'change', function (e) { doc.attach.dm = e.target.checked; });
  document.getElementById('atch').checked = !!doc.attach.channel; bind('atch', 'change', function (e) { doc.attach.channel = e.target.checked; });
  bind('addtext', 'click', function () { doc.layers.push({ type: 'text', text: 'Welcome ${username}!', x: 30, y: 30, size: 36, color: '#ffffff', weight: 'bold', align: 'left' }); sel = doc.layers.length - 1; draw(); });
  bind('addavatar', 'click', function () { doc.layers.push({ type: 'avatar', x: 30, y: 30, size: 128, round: true }); sel = doc.layers.length - 1; draw(); });
  bind('imgupload', 'change', function (e) { upload(e.target.files[0], function (id) { doc.layers.push({ type: 'image', assetId: id, x: 30, y: 30, w: 160, h: 160, round: false }); sel = doc.layers.length - 1; draw(); }); e.target.value = ''; });
  bind('bgupload', 'change', function (e) { upload(e.target.files[0], function (id) { doc.background = { type: 'image', assetId: id }; draw(); }); e.target.value = ''; });
  bind('bgclear', 'click', function () { doc.background = { type: 'color', color: document.getElementById('bgcolor').value || '#1e2230' }; draw(); });
  bind('save', 'click', function () { var btn = document.getElementById('save'); fetch('/welcome/' + G + '/card', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }).then(function (r) { return r.json(); }).then(function (j) { btn.textContent = j && j.ok ? 'Saved ✓' : 'Error'; setTimeout(function () { btn.textContent = 'Save'; }, 1500); }).catch(function () { alert('Save failed.'); }); });
  bind('preview', 'click', function () { fetch('/welcome/' + G + '/card/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }).then(function (r) { if (!r.ok) throw 0; return r.blob(); }).then(function (b) { document.getElementById('previewbox').innerHTML = '<h3>Server preview (sample member)</h3><img alt="preview" style="max-width:100%;border:1px solid #30363d;border-radius:6px">'; document.querySelector('#previewbox img').src = URL.createObjectURL(b); }).catch(function () { alert('Preview failed.'); }); });
  draw();
}

function cardEditorPage(gld, cfg) {
  const doc = cfg.card || { enabled: false, width: 1000, height: 300, background: { type: 'color', color: '#1e2230' }, attach: { dm: false, channel: true }, layers: [] };
  const json = JSON.stringify(doc).replace(/</g, '\\u003c');
  const body = `<div class="card"><h2>🖼️ ${esc(gld.name)} — welcome card
      <a class="btn sec" href="/welcome/${esc(gld.id)}" style="float:right">← back to welcome</a></h2>
    <label><input type="checkbox" id="enabled"> Card enabled (rendered + attached on join)</label>
    <div class="row">
      <div><label>Width</label><input id="cardw" type="number" min="200" max="2000"></div>
      <div><label>Height</label><input id="cardh" type="number" min="100" max="1200"></div>
      <div><label>Background color</label><input id="bgcolor" type="color" style="height:38px;padding:2px"></div>
      <div><label>Background image</label><input id="bgupload" type="file" accept="image/*">
        <button type="button" class="sec" id="bgclear" style="margin-top:6px">clear image</button></div>
    </div>
    <label>Attach card to</label>
    <div style="margin-bottom:6px">
      <label class="chk" style="display:inline-flex;margin-right:16px"><input type="checkbox" id="atdm"> DM welcome</label>
      <label class="chk" style="display:inline-flex"><input type="checkbox" id="atch"> Channel welcome</label>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:6px">
      <div style="flex:2;min-width:300px">
        <canvas id="cv" style="border:1px solid #30363d;background:#0d1117;max-width:100%;cursor:move"></canvas>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button type="button" id="addtext">+ Text</button>
          <button type="button" class="sec" id="addavatar">+ Avatar</button>
          <label class="btn sec" style="margin:0;cursor:pointer">+ Image<input id="imgupload" type="file" accept="image/*" style="display:none"></label>
          <button type="button" id="save">Save</button>
          <button type="button" class="sec" id="preview">Server preview</button>
        </div>
        <div id="previewbox" style="margin-top:12px"></div>
      </div>
      <div style="flex:1;min-width:240px"><h3>Layers</h3><div id="layers"></div><div id="props"></div>
        <p class="hint">Drag layers on the canvas to move. Text supports \${variables}. The avatar layer shows each joiner's avatar.</p></div>
    </div>
  </div>
  <style>.lyr{display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border:1px solid #21262d;border-radius:6px;margin-bottom:4px;cursor:pointer}.lyr.selsel{border-color:#58a6ff}.lyr button{padding:2px 7px;margin-left:3px;background:#21262d;border-color:#30363d}.lname{font-size:13px;overflow:hidden;white-space:nowrap}#props input,#props select{margin-bottom:2px}</style>
  <script>window.__CARD__=${json};window.__G__=${JSON.stringify(gld.id)};</script>
  <script>(${cardEditorClient.toString()})();</script>`;
  return layout(`Card · ${gld.name}`, body);
}

const STYLE = `
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#0e1116;color:#e6edf3}
  header{background:#161b22;border-bottom:1px solid #30363d;padding:12px 20px;display:flex;align-items:center;gap:16px}
  header h1{font-size:16px;margin:0}
  header .sp{flex:1}
  a{color:#58a6ff;text-decoration:none}
  a:hover{text-decoration:underline}
  main{max-width:1000px;margin:0 auto;padding:20px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin:0 0 16px}
  .card h2{font-size:14px;margin:0 0 12px;color:#8b949e;text-transform:uppercase;letter-spacing:.04em}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #21262d;font-size:13px}
  th{color:#8b949e;font-weight:600}
  .pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px}
  .ok{background:#1a3a1f;color:#3fb950}
  .bad{background:#3a1a1a;color:#f85149}
  .muted{color:#8b949e}
  input,textarea,select{width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:8px;font:inherit}
  textarea{min-height:160px;font-family:ui-monospace,Menlo,Consolas,monospace}
  label{display:block;margin:10px 0 4px;color:#8b949e}
  .row{display:flex;gap:12px}.row>div{flex:1}
  button,.btn{background:#238636;border:1px solid #2ea043;color:#fff;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}
  button.sec{background:#21262d;border-color:#30363d}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
  .kv{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:10px}
  .kv b{display:block;font-size:20px}
  code{background:#0d1117;padding:1px 5px;border-radius:4px;border:1px solid #21262d}
  h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em}
  details{margin:8px 0;border:1px solid #21262d;border-radius:6px;padding:0 10px}
  details[open]{padding-bottom:10px}
  summary{cursor:pointer;padding:8px 0}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chip{background:#21262d;border:1px solid #30363d;color:#9da7b3;border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer;font-family:ui-monospace,Menlo,Consolas,monospace}
  .chip:hover{color:#e6edf3;border-color:#58a6ff}
  .checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:2px;max-height:170px;overflow:auto;background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:8px}
  .chk{display:flex;align-items:center;gap:6px;margin:0;color:#e6edf3;font-size:13px}
  .chk input{width:auto}
  .hint{font-size:12px;color:#8b949e;margin:2px 0 0}
  .switch{display:inline-flex;align-items:center;gap:10px;cursor:pointer;margin:10px 0;font-size:14px;color:#e6edf3}
  .switch input{display:none}
  .switch .slider{position:relative;width:42px;height:24px;background:#30363d;border-radius:999px;transition:.2s;flex:0 0 auto}
  .switch .slider::before{content:"";position:absolute;width:18px;height:18px;left:3px;top:3px;background:#8b949e;border-radius:50%;transition:.2s}
  .switch input:checked + .slider{background:#238636}
  .switch input:checked + .slider::before{transform:translateX(18px);background:#fff}
`;

function layout(title, body, { authed = true, wide = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(COMMUNITY_NAME)}</title><style>${STYLE}</style></head><body>
<header><h1>🎮 ${esc(COMMUNITY_NAME)}</h1>
${authed ? '<a href="/">Dashboard</a><a href="/stats">Stats</a><a href="/welcome">Welcome</a>' : ''}
<span class="sp"></span>
${authed ? '<form method="post" action="/logout" style="margin:0"><button class="sec" type="submit">Logout</button></form>' : ''}
</header><main${wide ? ' class="stats-main"' : ''}>${body}</main></body></html>`;
}

function start(deps) {
  const { client, db, stats, query, gtime, getConfig } = deps;
  if (process.env.ADMIN_KEY && process.env.ADMIN_KEY.length < 16) {
    console.warn('ADMIN_KEY is shorter than 16 characters - use a long random value.');
  }
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  // CSRF: every state-changing request must come from this origin. Browsers
  // always send Origin on cross-site POSTs; fall back to Referer when absent.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const src = req.headers.origin || req.headers.referer || '';
    let host = null;
    try {
      host = new URL(src).host;
    } catch {
      host = null;
    }
    if (host && (host === req.headers.host || host === req.headers['x-forwarded-host'])) return next();
    return res.status(403).send('Forbidden (cross-origin request)');
  });
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  // JSON is parsed per-route (card save / image upload) so large image uploads
  // are only buffered on the authed card routes, never globally.

  // ---- public health check ----
  app.get('/healthz', (req, res) => {
    // Always 200 so Railway's deploy healthcheck passes during the boot grace
    // window, but surface real Discord readiness for observability.
    const ready = !!(client && client.isReady && client.isReady());
    res.json({
      status: 'ok',
      ready,
      ws: client && client.ws ? client.ws.status : null,
      uptime: Math.round(process.uptime()),
      db: { enabled: db.isEnabled(), up: db.isUp() },
      ts: Date.now(),
    });
  });

  // ---- auth ----
  function setSession(req, res) {
    const secure = (req.headers['x-forwarded-proto'] || '').includes('https') || req.secure;
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${makeToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`
    );
  }
  function requireAuth(req, res, next) {
    if (verifyToken(getCookie(req, COOKIE))) return next();
    return res.redirect('/login');
  }

  app.get('/login', (req, res) => {
    if (verifyToken(getCookie(req, COOKIE))) return res.redirect('/');
    const noKey = !process.env.ADMIN_KEY;
    const err = req.query.e ? '<p class="pill bad">Invalid key.</p>' : '';
    const body = noKey
      ? '<div class="card"><h2>Locked</h2><p class="muted">ADMIN_KEY is not set, so the panel is disabled. Set it in the environment.</p></div>'
      : `<div class="card"><h2>Sign in</h2>${err}
         <form method="post" action="/login">
         <label>Admin key</label><input type="password" name="key" autofocus autocomplete="current-password">
         <p></p><button type="submit">Sign in</button></form></div>`;
    res.send(layout('Login', body, { authed: false }));
  });

  app.post('/login', (req, res) => {
    if (loginBlocked(req.ip)) {
      return res.status(429).send(layout('Login', '<div class="card"><h2>Too many attempts</h2><p class="muted">Try again later.</p></div>', { authed: false }));
    }
    if (keyMatches(req.body.key || '')) {
      loginFails.delete(req.ip);
      setSession(req, res);
      return res.redirect('/');
    }
    noteLoginFail(req.ip);
    return res.redirect('/login?e=1');
  });

  app.post('/logout', (req, res) => {
    const secure = (req.headers['x-forwarded-proto'] || '').includes('https') || req.secure;
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
    res.redirect('/login');
  });

  app.use(requireAuth);

  // Panel assets (chart library + stats app) — behind the session check, same
  // as every other page.
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: false }));

  // ---- stats panel (page + JSON API) ----
  analytics.setConfigProvider(getConfig);
  adminStats.mount(app, { client, db, stats, query, gtime, getConfig, layout });

  // ---- dashboard ----
  app.get('/', async (req, res) => {
    const [dbState, tableSizes, snapCount] = await Promise.all([
      db.getDbState(),
      db.getTableSizes(),
      db.getSnapshotCount(),
    ]);
    const fileStats = stats.getFileStats();

    const dbPill = dbState.enabled
      ? dbState.up
        ? '<span class="pill ok">connected</span>'
        : '<span class="pill bad">down (file fallback)</span>'
      : '<span class="pill muted">disabled (file fallback)</span>';

    const guildCount = client.guilds ? client.guilds.cache.size : 0;

    // Per-game live-ish view from the local cache (fast, DB-independent).
    // Real server names come from the metadata the poller records; the full
    // analytics live at /stats.
    const tracked = await analytics.listServers().catch(() => []);
    let gameRows = '';
    let liveTotal = 0;
    for (const s of tracked) {
      const today = stats.getTodayPeak(s.game, s.id);
      const p24 = stats.get24hPeak(s.game, s.id);
      if (s.online) liveTotal += s.players || 0;
      gameRows += `<tr><td><span class="muted">${esc(s.game)}</span></td>
        <td>${esc(s.name)} ${s.online ? '' : '<span class="pill bad">offline</span>'}</td>
        <td><code>${esc(s.address || s.id)}</code></td>
        <td>${s.online ? s.players : '—'}</td><td>${today}</td><td>${p24}</td></tr>`;
    }
    if (!gameRows) gameRows = '<tr><td colspan="6" class="muted">No servers configured (servers.json / SERVERS_JSON).</td></tr>';

    const tableRows =
      tableSizes.length
        ? tableSizes.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td>${t.rows}</td><td>${bytes(t.bytes)}</td></tr>`).join('')
        : '<tr><td colspan="3" class="muted">No DB / no tables.</td></tr>';

    const body = `
      <div class="card"><h2>Status</h2>
        <div class="grid">
          <div class="kv"><span class="muted">Bot</span><b>${client.user ? esc(client.user.tag) : '—'}</b></div>
          <div class="kv"><span class="muted">Guilds</span><b>${guildCount}</b></div>
          <div class="kv"><span class="muted">Uptime</span><b>${Math.round(process.uptime() / 60)}m</b></div>
          <div class="kv"><span class="muted">Postgres</span><b style="font-size:14px">${dbPill}</b></div>
          <div class="kv"><span class="muted">Local time</span><b style="font-size:16px">${esc(gtime.localDateTimeString())}</b></div>
          <div class="kv"><span class="muted">Players now</span><b>${liveTotal}</b></div>
        </div>
      </div>

      <div class="card"><h2>Servers (cached)
        <a class="btn" href="/stats" style="float:right;padding:4px 12px">📊 Open stats panel</a></h2>
        <table><thead><tr><th>Game</th><th>Server</th><th>Address</th><th>Now</th><th>Today peak</th><th>24h</th></tr></thead>
        <tbody>${gameRows}</tbody></table>
        <p class="hint">Peak times, server-vs-server comparison, records and exports live in the
          <a href="/stats">stats panel</a>.</p>
      </div>

      <div class="card"><h2>Storage</h2>
        <div class="grid">
          <div class="kv"><span class="muted">stats.json</span><b style="font-size:16px">${bytes(fileStats.statsBytes)}</b><span class="muted">${fileStats.totalEntries} entries</span></div>
          <div class="kv"><span class="muted">DB snapshots</span><b style="font-size:16px">${snapCount == null ? '—' : snapCount}</b></div>
          <div class="kv"><span class="muted">guild-config.json</span><b style="font-size:16px">${bytes(fileStats.guildConfigBytes)}</b><span class="muted">${fileStats.guildCount} guild(s)</span></div>
        </div>
        <p></p>
        <table><thead><tr><th>Table</th><th>Rows</th><th>Size</th></tr></thead><tbody>${tableRows}</tbody></table>
        ${dbState.lastError ? `<p class="muted">Last DB error: ${esc(dbState.lastError)}</p>` : ''}
      </div>`;
    res.send(layout('Dashboard', body));
  });

  // ---- welcome: guild list ----
  app.get('/welcome', async (req, res) => {
    const guilds = client.guilds ? [...client.guilds.cache.values()] : [];
    const cfgs = await db.getAllGuildConfigs();
    let rows = '';
    for (const gld of guilds) {
      const c = cfgs[gld.id] || {};
      const dm = c.dm && c.dm.enabled !== false ? '<span class="pill ok">on</span>' : '<span class="pill muted">off</span>';
      const ch = c.channel && c.channel.enabled !== false ? '<span class="pill ok">on</span>' : '<span class="pill muted">off</span>';
      rows += `<tr><td>${esc(gld.name)}</td><td class="muted"><code>${esc(gld.id)}</code></td>
        <td>${dm}</td><td>${ch}</td><td><a href="/welcome/${esc(gld.id)}">Edit →</a></td></tr>`;
    }
    if (!rows) rows = '<tr><td colspan="5" class="muted">Bot is not in any guild yet.</td></tr>';
    const body = `<div class="card"><h2>Welcome config — guilds</h2>
      <table><thead><tr><th>Guild</th><th>ID</th><th>DM</th><th>Channel</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
    res.send(layout('Welcome', body));
  });

  // ---- welcome: editor ----
  app.get('/welcome/:guildId', async (req, res) => {
    const gld = client.guilds && client.guilds.cache.get(req.params.guildId);
    if (!gld) return res.status(404).send(layout('Not found', '<div class="card">Unknown guild.</div>'));
    const cfg = await db.getGuildConfig(gld.id);
    const saved = req.query.saved ? '<span class="pill ok">Saved.</span>' : '';
    const dmOn = !!(cfg.dm && cfg.dm.enabled !== false);
    const chOn = !!(cfg.channel && cfg.channel.enabled !== false);

    const textChannels = [...gld.channels.cache.values()]
      .filter((c) => c.isTextBased && c.isTextBased())
      .sort((a, b) => (a.rawPosition || 0) - (b.rawPosition || 0));
    const assignableRoles = [...gld.roles.cache.values()]
      .filter((r) => r.id !== gld.id && !r.managed)
      .sort((a, b) => b.rawPosition - a.rawPosition);

    const body = `<div class="card"><h2>${esc(gld.name)} — welcome ${saved}</h2>
      <form method="post" action="/welcome/${esc(gld.id)}">
        <h3 style="margin:8px 0;color:#8b949e">📨 DM welcome</h3>
        <label class="switch"><input type="checkbox" name="dm_enabled" ${dmOn ? 'checked' : ''}><span class="slider"></span> Send a DM to new members</label>
        <label>Message (markdown + \${variables})</label>
        <textarea name="dm_content" placeholder="Long-form DM. YouTube URLs embed; other URLs auto-wrapped.">${esc(cfg.dm ? cfg.dm.content || '' : '')}</textarea>
        <label>Image URL (optional; supports \${useravatarurl}, \${guildbannerurl}, …)</label>
        <input name="dm_image" value="${esc(cfg.dm ? cfg.dm.imageUrl || '' : '')}" placeholder="https://...">

        <h3 style="margin:16px 0 8px;color:#8b949e">💬 Channel welcome</h3>
        <label class="switch"><input type="checkbox" name="channel_enabled" ${chOn ? 'checked' : ''}><span class="slider"></span> Post in the welcome channel</label>
        <label>Message (short: ping + one line + emoji)</label>
        <textarea name="channel_content" style="min-height:80px">${esc(cfg.channel ? cfg.channel.content || '' : '')}</textarea>
        <label>Image URL (optional)</label>
        <input name="channel_image" value="${esc(cfg.channel ? cfg.channel.imageUrl || '' : '')}" placeholder="https://...">

        <h3 style="margin:16px 0 8px;color:#8b949e">⚙️ Targets & roles</h3>
        <div class="row">
          <div><label>Welcome channel</label><select name="welcome_channel_id">${channelOptionsHtml(textChannels, cfg.welcomeChannelId)}</select>
            <p class="hint">Where the channel welcome is posted.</p></div>
          <div><label>Log channel</label><select name="log_channel_id">${channelOptionsHtml(textChannels, cfg.logChannelId)}</select>
            <p class="hint">Audit trail of each join.</p></div>
        </div>
        <label>Auto-roles assigned on join</label>
        ${roleChecksHtml(assignableRoles, cfg.autoRoles)}
        <p></p><button type="submit">Save</button>
        <a class="btn sec" href="/welcome" style="margin-left:8px">Back</a>
      </form>
    </div>
    <div class="card"><h2>🖼️ Welcome card (image)</h2>
      <p class="hint">Design a layered image (background, the joiner's avatar, text) attached to the welcome message.</p>
      <a class="btn" href="/welcome/${esc(gld.id)}/card">Open card editor</a>
      ${cfg.card && cfg.card.enabled ? '<span class="pill ok" style="margin-left:8px">enabled</span>' : '<span class="pill muted" style="margin-left:8px">off</span>'}
    </div>
    ${varChipsHtml()}`;
    res.send(layout(`Welcome · ${gld.name}`, body));
  });

  app.post('/welcome/:guildId', async (req, res) => {
    const gld = client.guilds && client.guilds.cache.get(req.params.guildId);
    if (!gld) return res.status(404).send(layout('Not found', '<div class="card">Unknown guild.</div>'));
    const b = req.body;
    // Keep the message text/image even when the toggle is off, so existing
    // settings persist and reappear in the editor; `enabled` is the toggle.
    const buildMsg = (enabled, content, image) => {
      const c = content || '';
      const img = (image || '').trim();
      if (!c && !img) return null; // nothing configured at all
      const m = { content: c, enabled: !!enabled };
      if (img) m.imageUrl = img;
      return m;
    };
    const dm = buildMsg(b.dm_enabled, b.dm_content, b.dm_image);
    const channel = buildMsg(b.channel_enabled, b.channel_content, b.channel_image);
    const autoRoles = [...new Set(String(b.auto_roles || '').split(/[\s,]+/).filter(Boolean))];
    await db.setGuildConfig(gld.id, {
      dm,
      channel,
      welcomeChannelId: (b.welcome_channel_id || '').trim() || null,
      logChannelId: (b.log_channel_id || '').trim() || null,
      autoRoles,
    });
    res.redirect(`/welcome/${gld.id}?saved=1`);
  });

  // ---- welcome card (layered image) ----
  const guildOr404 = (req, res) => {
    const gld = client.guilds && client.guilds.cache.get(req.params.guildId);
    if (!gld) {
      res.status(404).send(layout('Not found', '<div class="card">Unknown guild.</div>'));
      return null;
    }
    return gld;
  };

  app.get('/welcome/:guildId/card', async (req, res) => {
    const gld = guildOr404(req, res);
    if (!gld) return;
    const cfg = await db.getGuildConfig(gld.id);
    res.send(cardEditorPage(gld, cfg));
  });

  app.post('/welcome/:guildId/card', express.json({ limit: '512kb' }), async (req, res) => {
    const gld = guildOr404(req, res);
    if (!gld) return;
    await db.setGuildConfig(gld.id, { card: sanitizeCard(req.body) });
    res.json({ ok: true });
  });

  app.post('/welcome/:guildId/card/preview', express.json({ limit: '512kb' }), async (req, res) => {
    const gld = guildOr404(req, res);
    if (!gld) return;
    try {
      const doc = sanitizeCard({ ...req.body, enabled: true });
      const buf = await card.renderCard(doc, card.sampleMember(gld), { getAsset: db.getAsset });
      if (!buf) return res.status(204).end();
      res.setHeader('content-type', 'image/png');
      res.end(buf);
    } catch (e) {
      console.error(`card preview failed: ${e.message}`);
      res.status(500).json({ error: 'preview failed' });
    }
  });

  app.post('/welcome/:guildId/asset', express.json({ limit: '8mb' }), async (req, res) => {
    const gld = guildOr404(req, res);
    if (!gld) return;
    const dataUrl = (req.body && req.body.dataUrl) || '';
    const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl);
    if (!m || !ASSET_MIMES.has(m[1].toLowerCase())) return res.status(400).json({ error: 'expected a PNG, JPEG, GIF or WebP data URL' });
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'image too large (max 4MB)' });
    const id = crypto.randomUUID();
    await db.saveAsset(gld.id, id, m[1].toLowerCase(), buf);
    res.json({ id });
  });

  app.get('/welcome/:guildId/asset/:assetId', async (req, res) => {
    const a = await db.getAsset(req.params.assetId);
    if (!a) return res.status(404).end();
    // Never serve a stored type that could execute in the panel origin.
    res.setHeader('content-type', ASSET_MIMES.has(a.mime) ? a.mime : 'application/octet-stream');
    res.setHeader('cache-control', 'private, max-age=300');
    res.end(a.bytes);
  });

  const port = Number(process.env.PORT || process.env.ADMIN_PORT || 3000);
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Admin panel + /healthz listening on :${port}`);
  });
  server.on('error', (e) => console.error('admin server error:', e.message));
  return server;
}

module.exports = { start };
