'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('notify')
    .setDescription('Give yourself the notification role'),
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
      await interaction.member.roles.add(roleId, 'notify self-assign');
      return interaction.reply({ content: '✅ Notifications enabled.', flags: MessageFlags.Ephemeral });
    } catch (e) {
      return interaction.reply({ content: `❌ Failed: ${e.message}`, flags: MessageFlags.Ephemeral });
    }
  },
};
