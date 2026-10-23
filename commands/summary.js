'use strict';

const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('summary').setDescription('Short overview of all games'),
  async execute(interaction) {
    await interaction.deferReply();
    const hub = interaction.client.hub;
    const all = await hub.gatherAll();
    let grand = 0;
    const lines = [];
    for (const game of ['ragemp', 'redm', 'samp']) {
      const arr = all[game] || [];
      const online = arr.reduce((a, s) => a + (s.online ? s.players || 0 : 0), 0);
      grand += online;
      const info = hub.embeds.GAME_INFO[game];
      const top = arr
        .filter((s) => s.online)
        .sort((a, b) => (b.players || 0) - (a.players || 0))[0];
      const lead = top ? ` · top: ${top.name} (${top.players})` : '';
      lines.push(`${info.emoji} **${info.label}**: ${online} online${lead}`);
    }
    // Server names come from remote game-server APIs: never let them ping anyone.
    await interaction.editReply({
      content: `👥 **${grand} players online in total**\n${lines.join('\n')}`,
      allowedMentions: { parse: [] },
    });
  },
};
