'use strict';

const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('total').setDescription('Combined status across all games'),
  async execute(interaction) {
    await interaction.deferReply();
    const hub = interaction.client.hub;
    const all = await hub.gatherAll();
    const embed = hub.embeds.buildTotalEmbed(all, { updatedMs: Date.now() });
    await interaction.editReply({ embeds: [embed] });
  },
};
