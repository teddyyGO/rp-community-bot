'use strict';

/**
 * Status embed builders. The community name comes from COMMUNITY_NAME.
 *
 * Data contract (computed by index.js from stats/db) per server:
 *   { id, name, online, players, maxplayers,
 *     todayPeak, peak24h, daily: [{day, peak}], spark: [numbers] }
 */

const { EmbedBuilder } = require('discord.js');
const g = require('./gtime');
const { COMMUNITY_NAME } = require('./config');

const TZ_LABEL = `UTC${g.UTC_OFFSET_HOURS >= 0 ? '+' : ''}${g.UTC_OFFSET_HOURS}`;

const GAME_INFO = {
  ragemp: { label: 'RAGE MP', emoji: '🟠', color: 0xe67e22 },
  redm: { label: 'RedM', emoji: '🔴', color: 0xc0392b },
  samp: { label: 'SA-MP', emoji: '🔵', color: 0x3498db },
};
const TOTAL_COLOR = 0xe74c3c;

const TICKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Render a list of numbers as a block-character sparkline. */
function sparkline(values) {
  const nums = (values || []).map((v) => Number(v) || 0);
  if (!nums.length) return '—';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (max === min) {
    return (max === 0 ? TICKS[0] : TICKS[3]).repeat(nums.length);
  }
  return nums
    .map((v) => {
      const idx = Math.round(((v - min) / (max - min)) * (TICKS.length - 1));
      return TICKS[Math.max(0, Math.min(TICKS.length - 1, idx))];
    })
    .join('');
}

function fieldName(s) {
  const dot = s.online ? '🟢' : '🔴';
  return `${dot} ${s.name || s.id}`;
}

function fieldValue(s) {
  const daily = Array.isArray(s.daily) ? s.daily : [];
  const dailyPeaks = daily.map((d) => d.peak);
  const dailyMax = dailyPeaks.length ? Math.max(...dailyPeaks) : 0;
  const slots = s.maxplayers ? ` / ${s.maxplayers}` : '';
  const lines = [
    `👥 Online: **${s.online ? s.players : 0}**${slots}`,
    `📈 Peak (today): **${s.todayPeak || 0}**`,
    `🕘 24h peak: **${s.peak24h || 0}**`,
    `〽️ ${sparkline(s.spark)}`,
    `📅 Last 7 days: ${sparkline(dailyPeaks)} (max ${dailyMax})`,
  ];
  return lines.join('\n');
}

function buildGameEmbed(game, serversData, opts = {}) {
  const info = GAME_INFO[game] || { label: game, emoji: '🎮', color: 0x2c3e50 };
  const updatedMs = opts.updatedMs || g.nowMs();
  const data = Array.isArray(serversData) ? serversData : [];
  const totalOnline = data.reduce((a, s) => a + (s.online ? s.players || 0 : 0), 0);

  const e = new EmbedBuilder()
    .setColor(info.color)
    .setTitle(`${info.emoji} ${info.label} — Server status`)
    .setDescription(`👥 Total online: **${totalOnline}** players`)
    .setFooter({ text: `Updated ${g.localTimeString(updatedMs)} (${TZ_LABEL}) • ${COMMUNITY_NAME}` })
    .setTimestamp(new Date(updatedMs));

  if (!data.length) {
    e.addFields({ name: '—', value: 'No servers configured.' });
    return e;
  }

  // Embeds allow at most 25 fields.
  for (const s of data.slice(0, 25)) {
    e.addFields({ name: fieldName(s), value: fieldValue(s) });
  }
  if (data.length > 25) {
    e.addFields({ name: '…', value: `+${data.length - 25} more server(s)` });
  }
  return e;
}

function buildTotalEmbed(allGames, opts = {}) {
  const updatedMs = opts.updatedMs || g.nowMs();
  let grand = 0;
  const lines = [];
  for (const game of ['ragemp', 'redm', 'samp']) {
    const arr = Array.isArray(allGames[game]) ? allGames[game] : [];
    const online = arr.reduce((a, s) => a + (s.online ? s.players || 0 : 0), 0);
    const up = arr.filter((s) => s.online).length;
    grand += online;
    const info = GAME_INFO[game];
    lines.push(`${info.emoji} **${info.label}** — ${online} online · ${up}/${arr.length} servers up`);
  }

  return new EmbedBuilder()
    .setColor(TOTAL_COLOR)
    .setTitle(`🎮 ${COMMUNITY_NAME} — Total status`)
    .setDescription(`👥 **${grand} players online in total**\n\n${lines.join('\n')}`)
    .setFooter({ text: `Updated ${g.localTimeString(updatedMs)} (${TZ_LABEL}) • ${COMMUNITY_NAME}` })
    .setTimestamp(new Date(updatedMs));
}

module.exports = { sparkline, buildGameEmbed, buildTotalEmbed, GAME_INFO };
