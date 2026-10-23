'use strict';

const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Latency check'),
  async execute(interaction) {
    await interaction.reply('🏓 ...');
    const sent = await interaction.fetchReply();
    const rtt = sent.createdTimestamp - interaction.createdTimestamp;
    const ws = Math.round(interaction.client.ws.ping);
    await interaction.editReply(`🏓 Pong! • RTT: ${rtt}ms • WS: ${ws < 0 ? 'n/a' : `${ws}ms`}`);
  },
};
