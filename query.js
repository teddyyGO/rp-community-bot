'use strict';

/**
 * Live player-count queries for the three tracked games.
 *
 *  - RageMP : the official masterlist (https://cdn.rage.mp/master/) returns a
 *             JSON object keyed by "host:port" with { players, maxplayers, ... }.
 *             One fetch covers every RageMP server; cached briefly.
 *  - SAMP   : SA-MP UDP query mechanism. We send the 11-byte 'i' (info) request
 *             and read players/maxplayers from the response (little-endian).
 *  - RedM   : RedM/FiveM servers expose HTTP /dynamic.json with
 *             { clients, sv_maxclients }. Fallback to /players.json length.
 *
 * Every function resolves to { online, players, maxplayers, [name], [error] }
 * and never throws - an unreachable server simply reports online:false.
 */

const dgram = require('dgram');
const dns = require('dns').promises;

const UA = 'rp-community-bot/1.0 (+server-status)';

// ---------------------------------------------------------------------------
// RageMP - masterlist
// ---------------------------------------------------------------------------

const RAGEMP_MASTER_URL = 'https://cdn.rage.mp/master/';
const MASTER_TTL_MS = 45 * 1000;
let masterCache = { at: 0, data: null };

async function fetchRageMpMaster() {
  if (masterCache.data && Date.now() - masterCache.at < MASTER_TTL_MS) {
    return masterCache.data;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(RAGEMP_MASTER_URL, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) throw new Error(`masterlist HTTP ${res.status}`);
    const data = await res.json();
    masterCache = { at: Date.now(), data };
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function queryRageMP(server, master) {
  try {
    const list = master || (await fetchRageMpMaster());
    const key = `${server.host}:${server.port}`;
    const entry = list[key];
    if (!entry) {
      // Not present on the masterlist => treated as offline / unlisted.
      return { online: false, players: 0, maxplayers: server.maxplayers || 0 };
    }
    return {
      online: true,
      players: Number(entry.players) || 0,
      maxplayers: Number(entry.maxplayers) || 0,
      name: entry.name,
    };
  } catch (e) {
    return { online: false, players: 0, maxplayers: 0, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// SAMP - UDP query
// ---------------------------------------------------------------------------

function buildSampPacket(octets, port, opcode) {
  const buf = Buffer.alloc(11);
  buf.write('SAMP', 0, 'ascii');
  buf[4] = octets[0];
  buf[5] = octets[1];
  buf[6] = octets[2];
  buf[7] = octets[3];
  buf[8] = port & 0xff; // port low byte (little-endian)
  buf[9] = (port >> 8) & 0xff; // port high byte
  buf.write(opcode, 10, 'ascii');
  return buf;
}

async function querySAMP(server, timeoutMs = 2500) {
  let address;
  try {
    const r = await dns.lookup(server.host, { family: 4 });
    address = r.address;
  } catch (e) {
    return { online: false, players: 0, maxplayers: 0, error: `dns: ${e.message}` };
  }
  const octets = address.split('.').map((n) => parseInt(n, 10));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return { online: false, players: 0, maxplayers: 0, error: 'bad ipv4' };
  }

  const packet = buildSampPacket(octets, server.port, 'i');
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      resolve(res);
    };
    const timer = setTimeout(
      () => finish({ online: false, players: 0, maxplayers: 0, error: 'timeout' }),
      timeoutMs
    );

    sock.on('error', (e) => finish({ online: false, players: 0, maxplayers: 0, error: e.message }));
    sock.on('message', (msg) => {
      // Layout after the 11-byte echoed header:
      //   [11] password (u8)  [12..13] players (u16 LE)  [14..15] maxplayers (u16 LE)
      if (msg.length < 16) {
        return finish({ online: false, players: 0, maxplayers: 0, error: 'short response' });
      }
      try {
        finish({ online: true, players: msg.readUInt16LE(12), maxplayers: msg.readUInt16LE(14) });
      } catch (e) {
        finish({ online: false, players: 0, maxplayers: 0, error: e.message });
      }
    });

    sock.send(packet, server.port, address, (e) => {
      if (e) finish({ online: false, players: 0, maxplayers: 0, error: e.message });
    });
  });
}

// ---------------------------------------------------------------------------
// RedM / FiveM - HTTP
// ---------------------------------------------------------------------------

async function httpJson(url, timeoutMs, headers) {
  const r = await httpJsonEx(url, timeoutMs, headers);
  return r.body;
}

/**
 * Like httpJson but reports *why* it failed, so callers can tell "the API
 * answered and this server is not listed" (404) from "we could not reach the
 * API at all" (network/timeout). Only the former means the server is down.
 */
async function httpJsonEx(url, timeoutMs, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, ...(headers || {}) } });
    if (!res.ok) return { body: null, status: res.status, reachable: true };
    return { body: await res.json(), status: res.status, reachable: true };
  } catch (e) {
    return { body: null, status: 0, reachable: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Strip FiveM ^0-^9 colour codes from a server hostname. */
function cleanFivemName(s) {
  return String(s || '').replace(/\^[0-9]/g, '').trim();
}

/**
 * cfx.re servers API hosts, most current first.
 *
 * The API moved from servers-frontend.fivem.net to frontend.cfx-services.net;
 * the old host now answers 404 for every path, which silently reported every
 * RedM server as offline. We keep the legacy host as a fallback and remember
 * whichever host last worked, so a future move costs one extra request rather
 * than a total outage.
 */
const CFX_HOSTS = [
  'https://frontend.cfx-services.net/api/servers/single/',
  'https://servers-frontend.fivem.net/api/servers/single/',
];
let cfxHostIdx = 0;

const CFX_HEADERS = { Accept: 'application/json', Referer: 'https://servers.fivem.net/' };

/**
 * Query a FiveM/RedM server by its cfx.re join code (e.g. "abc123").
 *
 * Returns online:false when the API answers 404 (the code is not on the list —
 * server offline or retired). When the API itself is unreachable we report
 * online:false with an `error`, so callers can tell a real downtime from our
 * own blind spot.
 */
async function queryRedMByCode(code, timeoutMs = 6000) {
  const path = encodeURIComponent(code);
  let lastError = 'unreachable';

  // Try the remembered-good host first, then the others (only on hard failure).
  for (let i = 0; i < CFX_HOSTS.length; i++) {
    const idx = (cfxHostIdx + i) % CFX_HOSTS.length;
    const r = await httpJsonEx(`${CFX_HOSTS[idx]}${path}`, timeoutMs, CFX_HEADERS);
    const D = r.body && r.body.Data;
    if (D && D.clients != null) {
      cfxHostIdx = idx; // this host works - stick to it
      return {
        online: true,
        players: Number(D.clients) || 0,
        maxplayers: Number(D.sv_maxclients) || 0,
        name: cleanFivemName(D.hostname),
      };
    }
    if (r.status === 404) {
      // The API answered: this code simply is not listed right now.
      cfxHostIdx = idx;
      return { online: false, players: 0, maxplayers: 0 };
    }
    lastError = r.error || `HTTP ${r.status}`;
  }
  return { online: false, players: 0, maxplayers: 0, error: lastError };
}

async function queryRedM(server, timeoutMs = 6000) {
  // cfx.re join code (proxy-hosted, no public host:port) -> servers API.
  if (server.code) return queryRedMByCode(server.code, timeoutMs);

  // Direct host:port -> the server's own HTTP endpoint.
  const base = `http://${server.host}:${server.port}`;
  const dyn = await httpJson(`${base}/dynamic.json`, timeoutMs);
  if (dyn && dyn.clients != null) {
    return {
      online: true,
      players: Number(dyn.clients) || 0,
      maxplayers: Number(dyn.sv_maxclients) || 0,
      name: cleanFivemName(dyn.hostname),
    };
  }
  // Fallback: count entries in players.json.
  const players = await httpJson(`${base}/players.json`, timeoutMs);
  if (Array.isArray(players)) {
    return { online: true, players: players.length, maxplayers: 0 };
  }
  return { online: false, players: 0, maxplayers: 0 };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function queryServer(game, server, master) {
  switch (game) {
    case 'ragemp':
      return queryRageMP(server, master);
    case 'samp':
      return querySAMP(server);
    case 'redm':
      return queryRedM(server);
    default:
      return { online: false, players: 0, maxplayers: 0, error: `unknown game ${game}` };
  }
}

function decorate(s, r) {
  return { id: s.id, name: s.name, host: s.host, port: s.port, ...r };
}

/**
 * A dead cfx host answers 404 for *every* path, which is indistinguishable
 * per-request from "this code is not listed". At batch level it is not: every
 * single code 404-ing at once means the host moved, not that every tracked
 * server shut down in the same second. When that happens, rotate to the next
 * known host and retry once.
 */
async function queryRedmBatch(servers) {
  const run = () => Promise.all(servers.map(async (s) => decorate(s, await queryServer('redm', s))));

  let out = await run();
  const allMissing = out.length > 1 && out.every((r) => !r.online && !r.error);
  if (allMissing && CFX_HOSTS.length > 1) {
    console.warn(`cfx: all ${out.length} RedM codes 404 on ${CFX_HOSTS[cfxHostIdx]} - trying next host`);
    cfxHostIdx = (cfxHostIdx + 1) % CFX_HOSTS.length;
    const retry = await run();
    if (retry.some((r) => r.online)) {
      console.warn(`cfx: switched to ${CFX_HOSTS[cfxHostIdx]}`);
      return retry;
    }
    cfxHostIdx = (cfxHostIdx + 1) % CFX_HOSTS.length; // no better - restore
  }
  return out;
}

/**
 * Query every server of one game.
 * @returns {Promise<Array<{id,name,host,port,online,players,maxplayers}>>}
 */
async function queryGame(game, servers) {
  const list = servers || [];
  if (!list.length) return []; // nothing configured - do no network work at all

  if (game === 'redm') return queryRedmBatch(list);

  let master = null;
  if (game === 'ragemp') {
    try {
      master = await fetchRageMpMaster();
    } catch {
      master = null; // queryRageMP will report offline
    }
  }
  return Promise.all(
    list.map(async (s) => {
      const r = await queryServer(game, s, master);
      return decorate(s, r);
    })
  );
}

module.exports = {
  GAMES: ['ragemp', 'redm', 'samp'],
  fetchRageMpMaster,
  queryRageMP,
  querySAMP,
  queryRedM,
  queryRedMByCode,
  queryServer,
  queryGame,
};
