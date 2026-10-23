'use strict';

/**
 * Welcome system: per-guild DM + channel welcome messages on member join.
 *
 * - Variables like ${usermention} are resolved at send time.
 * - YouTube URLs stay bare so a trailer embeds inline; every other URL is
 *   wrapped in <> so it does not embed and compete with the trailer.
 * - Em/en dashes are normalized to hyphens.
 * - DM is long-form; channel welcome is short. A closed-DM failure is skipped
 *   silently (and logged). Optional auto-roles + audit log channel.
 */

// Matches a URL whose host is youtube.com / youtu.be / youtube-nocookie.com
// (optionally with a subdomain like www. or m.), so the trailer embeds.
const YT_RE = /^https?:\/\/(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com)(?:[/?#]|$)/i;

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

function buildContext(member) {
  const user = member.user;
  const guild = member.guild;
  const sec = (ms) => Math.floor(ms / 1000);
  const createdTs = user.createdTimestamp;
  const joinedTs = member.joinedTimestamp || Date.now();
  const now = Date.now();

  return {
    userid: user.id,
    usertag: user.tag,
    username: user.username,
    userglobalnickname: user.globalName || user.username,
    usernickname: member.nickname || '',
    userdisplayname: member.displayName,
    usermention: `<@${user.id}>`,
    useravatarurl: user.displayAvatarURL({ size: 1024 }),
    userserveravatarurl: member.displayAvatarURL({ size: 1024 }),
    usercreatedat: `<t:${sec(createdTs)}:F>`,
    usercreatedtimestamp: String(createdTs),
    userjoinedat: `<t:${sec(joinedTs)}:F>`,
    userjoinedtimestamp: String(joinedTs),
    nowtimestamp: String(now),
    guildid: guild.id,
    guildname: guild.name,
    guildiconurl: guild.iconURL({ size: 1024 }) || '',
    guildbannerurl: guild.bannerURL({ size: 1024 }) || '',
    guildmembercount: String(guild.memberCount),
    guildvanitycode: guild.vanityURLCode || '',
  };
}

/** Replace ${var} tokens. Unknown variables are left untouched (visible typos). */
function resolveVariables(template, ctx) {
  if (!template) return '';
  return String(template).replace(/\$\{(\w+)\}/g, (m, key) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ctx, k) ? ctx[k] : m;
  });
}

/**
 * Normalize dashes and wrap non-YouTube URLs in <> (so they do not embed).
 * YouTube URLs are left bare so the trailer embeds inline.
 */
function processText(text) {
  if (!text) return '';
  let out = String(text).replace(/[—–]/g, '-'); // em/en dash -> hyphen

  out = out.replace(/https?:\/\/[^\s<>]+/g, (match, offset, str) => {
    const prev = str[offset - 1];
    // Strip trailing sentence punctuation AND markdown emphasis markers so they
    // stay outside the angle brackets (e.g. **https://x** -> **<https://x>**).
    let trail = '';
    const tm = match.match(/[*_~`).,!?;:]+$/);
    let url = match;
    if (tm) {
      trail = tm[0];
      url = match.slice(0, match.length - trail.length);
    }
    if (prev === '<') return url + trail; // already inside <...>
    if (YT_RE.test(url)) return url + trail; // YouTube stays bare to embed
    return `<${url}>${trail}`;
  });

  return out;
}

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------

function resolveEmbed(em, ctx, links) {
  const t = (s) => {
    if (s == null) return s;
    const r = resolveVariables(s, ctx);
    return links ? processText(r) : r.replace(/[—–]/g, '-');
  };
  const out = { ...em };
  if (em.title) out.title = t(em.title);
  if (em.description) out.description = t(em.description);
  if (em.url) out.url = resolveVariables(em.url, ctx);
  if (em.author && em.author.name) out.author = { ...em.author, name: t(em.author.name) };
  if (em.footer && em.footer.text) out.footer = { ...em.footer, text: t(em.footer.text) };
  if (em.image && em.image.url) out.image = { ...em.image, url: resolveVariables(em.image.url, ctx) };
  if (em.thumbnail && em.thumbnail.url) out.thumbnail = { ...em.thumbnail, url: resolveVariables(em.thumbnail.url, ctx) };
  if (Array.isArray(em.fields)) {
    out.fields = em.fields.map((f) => ({ ...f, name: t(f.name), value: t(f.value) }));
  }
  return out;
}

/**
 * Build a discord.js message payload from a stored message JSON.
 * @param messageJson - { content?, embeds? } or a plain string.
 * @param member - the GuildMember being welcomed.
 * @param opts.links - apply URL/dash processing to text (default true).
 */
function buildMessage(messageJson, member, opts = {}) {
  const links = opts.links !== false;
  const ctx = buildContext(member);
  const payload = {};

  let content = '';
  if (typeof messageJson === 'string') content = messageJson;
  else if (messageJson && typeof messageJson.content === 'string') content = messageJson.content;

  content = resolveVariables(content, ctx);
  content = links ? processText(content) : content.replace(/[—–]/g, '-');
  if (content) payload.content = content;

  const embeds = [];
  if (messageJson && Array.isArray(messageJson.embeds)) {
    for (const em of messageJson.embeds) embeds.push(resolveEmbed(em, ctx, links));
  }
  // Attached image (supports variables like ${useravatarurl}); sent as an embed image.
  if (messageJson && messageJson.imageUrl) {
    const url = resolveVariables(String(messageJson.imageUrl), ctx).trim();
    if (/^https?:\/\//i.test(url)) embeds.push({ image: { url } });
  }
  if (embeds.length) payload.embeds = embeds;

  // A welcome message must have at least content or an embed.
  if (!payload.content && !payload.embeds) payload.content = '​';
  return payload;
}

// ---------------------------------------------------------------------------
// Join handler
// ---------------------------------------------------------------------------

/**
 * Run the welcome flow for a member who just joined.
 * deps: { db, logger }
 * @returns {Promise<string[]>} audit lines describing what happened.
 */
async function handleMemberJoin(member, deps = {}) {
  const { db, logger } = deps;
  const audit = [];

  if (member.user.bot) return audit; // don't welcome bots

  let cfg;
  try {
    cfg = await db.getGuildConfig(member.guild.id);
  } catch (e) {
    logger?.warn?.(`welcome: config load failed for ${member.guild.id}: ${e.message}`);
    return audit;
  }

  // Auto-roles
  if (Array.isArray(cfg.autoRoles) && cfg.autoRoles.length) {
    try {
      const roles = cfg.autoRoles.filter((id) => member.guild.roles.cache.has(id));
      if (roles.length) {
        await member.roles.add(roles, 'welcome auto-role');
        audit.push(`roles +${roles.length}`);
      }
    } catch (e) {
      audit.push(`roles failed (${e.message})`);
      logger?.warn?.(`welcome: auto-role failed for ${member.id}: ${e.message}`);
    }
  }

  // Welcome card (layered image) - render once, attach where configured.
  // card.js is required lazily here to avoid a require cycle (card -> welcome).
  let cardFile = null;
  const attach = (cfg.card && cfg.card.attach) || {};
  if (cfg.card && cfg.card.enabled) {
    try {
      const buf = await require('./card').renderCard(cfg.card, member, { getAsset: db.getAsset });
      if (buf) cardFile = { attachment: buf, name: 'welcome.png' };
    } catch (e) {
      logger?.warn?.(`welcome: card render failed for ${member.guild.id}: ${e.message}`);
    }
  }

  // DM welcome (toggle-gated; silently skip if DMs are closed)
  const dmOn = cfg.dm && cfg.dm.enabled !== false;
  if (dmOn && (cfg.dm.content || cfg.dm.imageUrl || (cardFile && attach.dm))) {
    try {
      const payload = buildMessage(cfg.dm, member, { links: true });
      if (cardFile && attach.dm) payload.files = [cardFile];
      await member.send(payload);
      audit.push('DM sent');
    } catch (e) {
      audit.push(`DM skipped (${e.code || e.message})`);
      logger?.warn?.(`welcome: DM to ${member.id} failed: ${e.message}`);
    }
  }

  // Channel welcome (short; toggle-gated)
  const chOn = cfg.channel && cfg.channel.enabled !== false;
  if (chOn && cfg.welcomeChannelId && (cfg.channel.content || cfg.channel.imageUrl || (cardFile && attach.channel))) {
    try {
      const ch = await member.guild.channels.fetch(cfg.welcomeChannelId).catch(() => null);
      if (ch && ch.isTextBased()) {
        // Only the new member may be pinged - never @everyone/@here/roles, even
        // if a template or an attacker-controlled display-name variable injects one.
        const payload = {
          ...buildMessage(cfg.channel, member, { links: true }),
          allowedMentions: { users: [member.id] },
        };
        if (cardFile && attach.channel) payload.files = [cardFile];
        await ch.send(payload);
        audit.push('channel posted');
      } else {
        audit.push('channel target missing');
      }
    } catch (e) {
      audit.push(`channel failed (${e.message})`);
      logger?.warn?.(`welcome: channel post failed in ${member.guild.id}: ${e.message}`);
    }
  }

  // Audit log
  if (cfg.logChannelId) {
    try {
      const lch = await member.guild.channels.fetch(cfg.logChannelId).catch(() => null);
      if (lch && lch.isTextBased()) {
        await lch.send({
          content: `📥 <@${member.id}> (\`${member.user.tag}\` · ${member.id}) joined — ${audit.join(' | ') || 'no actions'}`,
          allowedMentions: { parse: [] },
        });
      }
    } catch {
      /* audit logging is best-effort */
    }
  }

  return audit;
}

module.exports = {
  buildContext,
  resolveVariables,
  processText,
  buildMessage,
  handleMemberJoin,
};
