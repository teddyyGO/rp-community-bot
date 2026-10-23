'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unnotify')
    .setDescription('Remove the notification role'),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'Server only.', flags: MessageFlags.Ephemeral });
    }
    const roleId = interaction.client.hub.getConfig().pingRoleId;
    if (!roleId) {
      return interaction.reply({
        content: '⚠️ The notification role is not configured.',
        flags: MessageFlags.Ephemeral,
      });
    }
    try {
      await interaction.member.roles.remove(roleId, 'unnotify self-removal');
      return interaction.reply({ content: '✅ Notifications disabled.', flags: MessageFlags.Ephemeral });
    } catch (e) {
      return interaction.reply({ content: `❌ Failed: ${e.message}`, flags: MessageFlags.Ephemeral });
    }
  },
};
