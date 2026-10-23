'use strict';

// Shared factory for the per-game on-demand status commands.
// (Filenames starting with "_" are skipped by the command loader.)

const { SlashCommandBuilder } = require('discord.js');

function makeStatusCommand(game, name, description) {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(description),
    async execute(interaction) {
      await interaction.deferReply();
      const hub = interaction.client.hub;
      const data = await hub.gatherGameData(game);
      const embed = hub.embeds.buildGameEmbed(game, data, { updatedMs: Date.now() });
      await interaction.editReply({ embeds: [embed] });
    },
  };
}

module.exports = { makeStatusCommand };
