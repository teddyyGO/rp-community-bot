'use strict';

/**
 * Welcome card renderer: composites a layered image (background + image/avatar/
 * text layers) into a PNG per joining member. Text supports ${variables} and
 * Georgian-script glyphs (bundled Noto Sans Georgian, falls back to sans-serif). @napi-rs/canvas is lazy-loaded
 * so the bot pays no canvas memory until a card is actually rendered.
 *
 * Card document shape:
 *   { enabled, width, height,
 *     background: { type:'color', color } | { type:'image', assetId } | null,
 *     attach: { dm, channel },
 *     layers: [
 *       { type:'text',   text, x, y, size, color, weight:'normal'|'bold', align },
 *       { type:'image',  assetId, x, y, w, h, round },
 *       { type:'avatar', x, y, size, round },
 *     ] }
 */

const path = require('path');
const fs = require('fs');
const { buildContext, resolveVariables } = require('./welcome');

const FONT_FAMILY = 'Noto Sans Georgian';
let canvasLib = null;

function loadCanvas() {
  if (canvasLib) return canvasLib;
  canvasLib = require('@napi-rs/canvas');
  try {
    const fontPath = path.join(__dirname, 'fonts', 'NotoSansGeorgian.ttf');
    if (fs.existsSync(fontPath)) canvasLib.GlobalFonts.registerFromPath(fontPath, FONT_FAMILY);
  } catch {
    /* fall back to default fonts (no Georgian) */
  }
  return canvasLib;
}

function clamp(n, lo, hi, dflt) {
  n = Number(n);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function fontString(layer) {
  const size = clamp(layer.size, 6, 400, 32);
  const weight = layer.weight === 'bold' ? 'bold ' : '';
  return `${weight}${size}px "${FONT_FAMILY}", sans-serif`;
}

function drawCover(ctx, img, x, y, w, h) {
  const ir = img.width / img.height;
  const r = w / h;
  let sw = img.width;
  let sh = img.height;
  let sx = 0;
  let sy = 0;
  if (ir > r) {
    sw = img.height * r;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / r;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function withCircle(ctx, x, y, w, h, draw) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  draw();
  ctx.restore();
}

async function loadAssetImage(loadImage, getAsset, assetId) {
  if (!assetId || !getAsset) return null;
  try {
    const a = await getAsset(assetId);
    if (!a || !a.bytes) return null;
    return await loadImage(a.bytes);
  } catch {
    return null;
  }
}

async function loadAvatarImage(loadImage, member) {
  try {
    const url = member.user.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true });
    const res = await fetch(url);
    if (!res.ok) return null;
    return await loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<Buffer|null>} PNG buffer, or null if disabled / no layers.
 */
async function renderCard(card, member, deps = {}) {
  if (!card || !card.enabled || !Array.isArray(card.layers) || !card.layers.length) return null;
  const { createCanvas, loadImage } = loadCanvas();
  const getAsset = deps.getAsset;

  const W = Math.round(clamp(card.width, 200, 2000, 1000));
  const H = Math.round(clamp(card.height, 100, 1200, 300));
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const ctx2 = ctx; // alias

  // Background
  const bg = card.background;
  if (bg && bg.type === 'color' && bg.color) {
    ctx2.fillStyle = bg.color;
    ctx2.fillRect(0, 0, W, H);
  } else if (bg && bg.type === 'image' && bg.assetId) {
    const img = await loadAssetImage(loadImage, getAsset, bg.assetId);
    if (img) drawCover(ctx2, img, 0, 0, W, H);
  }

  const vars = buildContext(member);

  for (const layer of card.layers) {
    try {
      if (layer.type === 'text') {
        const text = resolveVariables(layer.text || '', vars);
        ctx2.font = fontString(layer);
        ctx2.fillStyle = layer.color || '#ffffff';
        ctx2.textBaseline = 'top';
        ctx2.textAlign = ['left', 'center', 'right'].includes(layer.align) ? layer.align : 'left';
        const x = clamp(layer.x, -2000, 4000, 0);
        let y = clamp(layer.y, -2000, 4000, 0);
        for (const line of String(text).split('\n')) {
          ctx2.fillText(line, x, y);
          y += clamp(layer.size, 6, 400, 32) * 1.2;
        }
      } else if (layer.type === 'image' || layer.type === 'avatar') {
        const x = clamp(layer.x, -2000, 4000, 0);
        const y = clamp(layer.y, -2000, 4000, 0);
        let img;
        let w;
        let h;
        if (layer.type === 'avatar') {
          img = await loadAvatarImage(loadImage, member);
          w = h = Math.round(clamp(layer.size, 8, 1200, 128));
        } else {
          img = await loadAssetImage(loadImage, getAsset, layer.assetId);
          w = Math.round(clamp(layer.w, 8, 2000, 128));
          h = Math.round(clamp(layer.h, 8, 1200, 128));
        }
        if (!img) continue;
        if (layer.round) {
          withCircle(ctx2, x, y, w, h, () => drawCover(ctx2, img, x, y, w, h));
        } else {
          ctx2.drawImage(img, x, y, w, h);
        }
      }
    } catch {
      /* skip a bad layer rather than fail the whole card */
    }
  }

  return canvas.toBuffer('image/png');
}

/** A synthetic member for panel previews (no real GuildMember needed). */
function sampleMember(guild) {
  const now = Date.now();
  const g = guild || {};
  return {
    id: '000000000000000000',
    nickname: null,
    displayName: 'Player',
    joinedTimestamp: now,
    user: {
      id: '000000000000000000',
      tag: 'player',
      username: 'Player',
      globalName: 'Player',
      bot: false,
      createdTimestamp: now - 1000 * 60 * 60 * 24 * 365,
      displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
    },
    displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
    guild: {
      id: g.id || '0',
      name: g.name || 'Server',
      memberCount: g.memberCount || 100,
      vanityURLCode: g.vanityURLCode || null,
      iconURL: () => (g.iconURL ? g.iconURL() : null),
      bannerURL: () => (g.bannerURL ? g.bannerURL() : null),
    },
  };
}

module.exports = { renderCard, sampleMember, FONT_FAMILY };
