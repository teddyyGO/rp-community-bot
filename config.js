'use strict';

/**
 * Loads the servers config (servers.json, or SERVERS_CONFIG) and normalizes it to a canonical shape, accepting
 * two file layouts:
 *
 *  (A) nested:   { channels:{game:id}, messages:{game:id}, pingRoleId,
 *                  servers:{ game:[ {id,name,host,port} | {code} ] } }
 *  (B) flat:     { ragemp:[...], redm:["abc123",...], samp:[...],
 *                  pinned:{ game:{channelId, messageId} } }
 *
 * A server entry may be:
 *  - a cfx.re join code (bare token, RedM/FiveM)        -> { code }
 *  - a "host:port" string (RageMP / SAMP / direct RedM) -> { host, port }
 *  - an object { id?, name?, host?, port?, code? }
 *
 * Canonical shape returned by getConfig():
 *   { channels:{game:id}, messages:{game:id}, pingRoleId,
 *     servers:{ game:[ {id,name,host?,port?,code?} ] }, _raw }
 * `_raw` is the original file object, preserved so write-backs keep the layout.
 */

const fs = require('fs');
const path = require('path');

const GAMES = ['ragemp', 'redm', 'samp'];
const KEYS = [...GAMES, 'total'];
const CONFIG_PATH = process.env.SERVERS_CONFIG
  ? path.resolve(process.env.SERVERS_CONFIG)
  : path.join(__dirname, 'servers.json');

// Display name used in embeds, the admin panel and audit-log reasons.
const COMMUNITY_NAME = (process.env.COMMUNITY_NAME || '').trim() || 'RP Community Hub';

let cache = null;
let cacheMtime = -1;

function normalizeServer(game, e) {
  if (typeof e === 'string') {
    const s = e.trim();
    if (!s) return null;
    if (s.includes(':')) {
      const [host, portStr] = s.split(':');
      return { id: s, name: s, host, port: Number(portStr) || 0 };
    }
    return { id: s, name: s, code: s }; // bare token -> cfx.re join code
  }
  if (e && typeof e === 'object') {
    const o = { ...e };
    if (!o.id) o.id = o.code || (o.host ? `${o.host}:${o.port}` : '') || o.name || '';
    if (!o.name) o.name = o.id;
    return o.id ? o : null;
  }
  return null;
}

function normalizeConfig(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const cfg = { channels: {}, messages: {}, servers: {}, pingRoleId: raw.pingRoleId || '', _raw: raw };
  for (const g of KEYS) {
    const pin = raw.pinned && raw.pinned[g];
    cfg.channels[g] = (raw.channels && raw.channels[g]) || (pin && pin.channelId) || '';
    cfg.messages[g] = (raw.messages && raw.messages[g]) || (pin && pin.messageId) || '';
  }
  for (const g of GAMES) {
    const src = (raw.servers && raw.servers[g]) || raw[g] || [];
    cfg.servers[g] = (Array.isArray(src) ? src : []).map((e) => normalizeServer(g, e)).filter(Boolean);
  }
  return cfg;
}

function getConfig() {
  try {
    const m = fs.statSync(CONFIG_PATH).mtimeMs;
    if (cache && m === cacheMtime) return cache;
    cache = normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    cacheMtime = m;
  } catch {
    // No file (e.g. fresh deploy on an ephemeral FS): fall back to inline JSON
    // from the SERVERS_JSON env var, else an empty config.
    if (!cache) {
      let raw = {};
      try {
        if (process.env.SERVERS_JSON) raw = JSON.parse(process.env.SERVERS_JSON);
      } catch (e) {
        console.error(`SERVERS_JSON is not valid JSON: ${e.message}`);
      }
      cache = normalizeConfig(raw);
    }
  }
  return cache;
}

function saveConfig(cfg) {
  const raw = cfg._raw || cfg;
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
  cache = cfg;
  try {
    cacheMtime = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {
    cacheMtime = -1;
  }
}

/**
 * Record a pinned status-message id, writing back in the file's own layout
 * (pinned-style if the file uses it, otherwise channels/messages).
 */
function persistPinnedMessage(cfg, key, channelId, messageId) {
  cfg.channels[key] = cfg.channels[key] || channelId || '';
  cfg.messages[key] = messageId;
  const raw = cfg._raw || (cfg._raw = {});
  if (raw.pinned || (!raw.messages && !raw.channels)) {
    raw.pinned = raw.pinned || {};
    raw.pinned[key] = { channelId: cfg.channels[key], messageId };
  } else {
    raw.messages = raw.messages || {};
    raw.messages[key] = messageId;
    if (channelId) {
      raw.channels = raw.channels || {};
      raw.channels[key] = raw.channels[key] || channelId;
    }
  }
  saveConfig(cfg);
}

module.exports = { GAMES, CONFIG_PATH, COMMUNITY_NAME, getConfig, saveConfig, persistPinnedMessage, normalizeConfig, normalizeServer };
