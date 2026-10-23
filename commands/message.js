'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('message')
    .setDescription('Send a message as the bot')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName('text').setDescription('Text (\\n = new line)').setRequired(true).setMaxLength(2000)
    )
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Channel (defaults to the current one)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    ),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'Server only.', flags: MessageFlags.Ephemeral });
    }
    // Default permissions can be overridden per guild, so re-check at runtime.
    if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ You need the Manage Server permission.', flags: MessageFlags.Ephemeral });
    }
    const text = interaction.options.getString('text').replace(/\\n/g, '\n');
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    // The bot must not post somewhere the invoking member cannot post themselves.
    const perms = channel && channel.permissionsFor ? channel.permissionsFor(interaction.member) : null;
    if (!perms || !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      return interaction.reply({ content: '❌ You cannot post in that channel.', flags: MessageFlags.Ephemeral });
    }
    // Role pings only for members who could ping roles/everyone themselves.
    const parse = perms.has(PermissionFlagsBits.MentionEveryone) ? ['users', 'roles'] : ['users'];
    try {
      await channel.send({ content: text, allowedMentions: { parse } });
      await interaction.reply({ content: `✅ Sent to <#${channel.id}>`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      await interaction.reply({ content: `❌ Failed: ${e.message}`, flags: MessageFlags.Ephemeral });
    }
  },
};
