'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('refresh')
    .setDescription('Refresh the pinned status embeds now')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    // Default permissions can be overridden per guild, so re-check at runtime.
    if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ You need the Manage Server permission.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await interaction.client.hub.refreshAll();
      await interaction.editReply('✅ Status refreshed.');
    } catch (e) {
      await interaction.editReply(`❌ Refresh failed: ${e.message}`);
    }
  },
};
