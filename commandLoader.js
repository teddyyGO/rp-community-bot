'use strict';

const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');

/**
 * Load every command module from a directory. Files starting with "_" (shared
 * helpers/factories) and modules without a {data, execute} pair are skipped.
 * @returns {{ commands: Collection<string, object>, json: object[] }}
 */
function loadCommands(dir = path.join(__dirname, 'commands')) {
  const commands = new Collection();
  const json = [];
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    files = [];
  }
  for (const file of files) {
    if (!file.endsWith('.js') || file.startsWith('_')) continue;
    let mod;
    try {
      mod = require(path.join(dir, file));
    } catch (e) {
      console.error(`Failed to load command ${file}: ${e.message}`);
      continue;
    }
    if (!mod || !mod.data || typeof mod.execute !== 'function') continue;
    commands.set(mod.data.name, mod);
    json.push(mod.data.toJSON());
  }
  return { commands, json };
}

module.exports = { loadCommands };
