'use strict';

// Manually (re)register slash commands. index.js also registers on startup,
// so this is optional - handy for a one-off global/guild sync.

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { loadCommands } = require('./commandLoader');

(async () => {
  const token = process.env.TOKEN;
  const clientId = process.env.CLIENT_ID;
  if (!token || !clientId) {
    console.error('TOKEN and CLIENT_ID are required.');
    process.exit(1);
  }

  const { json } = loadCommands();
  const rest = new REST({ version: '10' }).setToken(token);
  const guildId = process.env.GUILD_ID;

  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: json });
      console.log(`Registered ${json.length} guild command(s) to ${guildId}.`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: json });
      console.log(`Registered ${json.length} global command(s).`);
    }
  } catch (e) {
    console.error('Failed to register commands:', e.message);
    process.exit(1);
  }
})();
