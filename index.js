const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
const crypto = require('crypto');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENTID;
const GUILD_ID = process.env.GUILDID;

const validTypes = ['ban', 'warn', 'toolban', 'kick', 'mute'];

function parseDuration(input) {
  const units = {
    y: 31536000, // year
    w: 604800,   // week
    d: 86400,    // day
    h: 3600,     // hour
    m: 60,       // minute
    s: 1         // second
  };

  let totalSeconds = 0;
  const matches = input.match(/(\d+)([ywdhms])/gi);
  if (!matches) return null;

  for (const match of matches) {
    const [, num, unit] = match.match(/(\d+)([ywdhms])/i);
    totalSeconds += parseInt(num) * units[unit.toLowerCase()];
  }

  return totalSeconds;
}

const punishCommand = new SlashCommandBuilder()
  .setName('punish')
  .setDescription('Apply a punishment to a Roblox user')
  .addStringOption(opt => opt.setName('userid').setDescription('Roblox User ID').setRequired(true))
  .addStringOption(opt => opt.setName('type').setDescription('Type of punishment').setRequired(true).addChoices(
    { name: 'ban', value: 'ban' },
    { name: 'warn', value: 'warn' },
    { name: 'toolban', value: 'toolban' },
    { name: 'kick', value: 'kick' },
    { name: 'mute', value: 'mute' },
  ))
  .addStringOption(opt => opt.setName('duration').setDescription('Duration (e.g., 1d2h, 0 = permanent)').setRequired(true))
  .addStringOption(opt => opt.setName('reason').setDescription('Reason for punishment').setRequired(true));

const delPunishmentCommand = new SlashCommandBuilder()
  .setName('delpunishment')
  .setDescription('Remove a specific punishment by its ID')
  .addStringOption(opt => opt.setName('userid').setDescription('Roblox User ID').setRequired(true))
  .addStringOption(opt => opt.setName('punishid').setDescription('Punishment ID to delete').setRequired(true));

const historyCommand = new SlashCommandBuilder()
  .setName('history')
  .setDescription('View punishment history of a Roblox user')
  .addStringOption(opt => opt.setName('userid').setDescription('Roblox User ID').setRequired(true));

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

let punishments = {};
let deletedPunishments = {};

function filterExpired(arr) {
  const now = Date.now();
  return arr.filter(p => !p.expiresAt || new Date(p.expiresAt).getTime() > now);
}

function formatDateToLocaleShort(dateString, locale) {
  if (!dateString) return 'Permanent';
  return new Date(dateString).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

app.post('/punishments/:userId', (req, res) => {
  const userId = String(req.params.userId);
  const { type, reason, moderator, duration } = req.body;
  if (!type || !reason || !moderator || !validTypes.includes(type)) {
    return res.status(400).json({ success: false, message: "Invalid input" });
  }

  const durationSeconds = parseInt(duration);
  const expiresAt = durationSeconds > 0 ? new Date(Date.now() + durationSeconds * 1000).toISOString() : null;
  const id = crypto.randomUUID();
  const data = {
    id,
    type,
    reason,
    moderator,
    duration: durationSeconds,
    expiresAt,
    createdAt: new Date().toISOString()
  };

  if (!punishments[userId]) punishments[userId] = [];

  punishments[userId] = punishments[userId].filter(p => !(p.type === 'toolban' && p.expiresAt && new Date(p.expiresAt).getTime() <= Date.now()));

  punishments[userId].push(data);

  res.json({ success: true, id });
});

app.get('/punishments/:userId', (req, res) => {
  const userId = String(req.params.userId);
  if (punishments[userId]) {
    punishments[userId] = filterExpired(punishments[userId]);
  }
  const active = punishments[userId] || [];
  const deleted = deletedPunishments[userId] || [];
  const all = [...active, ...deleted];
  if (all.length === 0) return res.status(404).json([]);
  res.json(all);
});

app.delete('/punishments/:userId/:punishId', (req, res) => {
  const { userId, punishId } = req.params;
  if (!punishments[userId]) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  const index = punishments[userId].findIndex(p => p.id === punishId);
  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Punishment not found' });
  }

  const [removed] = punishments[userId].splice(index, 1);
  if (!deletedPunishments[userId]) deletedPunishments[userId] = [];
  deletedPunishments[userId].push(removed);

  res.json({ success: true, message: 'Punishment deleted' });
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rest = new REST({ version: '10' }).setToken(TOKEN);

client.once('ready', () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: [punishCommand.toJSON(), delPunishmentCommand.toJSON(), historyCommand.toJSON()]
    });
    console.log('Commands registered.');
  } catch (err) {
    console.error('Error registering commands:', err);
  }
})();

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.options.getString('userid');
  if (!userId || !/^\d+$/.test(userId)) {
    return interaction.reply({ content: 'Invalid Roblox user ID.', ephemeral: false });
  }

  if (interaction.commandName === 'punish') {
    const type = interaction.options.getString('type');
    const reason = interaction.options.getString('reason');
    const durationStr = interaction.options.getString('duration');
    
    const seconds = durationStr === '0' ? 0 : parseDuration(durationStr);
    if (seconds === null && durationStr !== '0') {
      return interaction.reply({ content: '❌ Invalid duration format.', ephemeral: false });
    }

    try {
      const response = await axios.post(`http://localhost:${PORT}/punishments/${userId}`, {
        type,
        reason,
        moderator: interaction.user.username,
        duration: seconds
      });
      interaction.reply({ content: `✅ Punishment applied (ID: ${response.data.id})`, ephemeral: false });
    } catch (error) {
      interaction.reply({ content: '❌ Failed to apply punishment.', ephemeral: false });
    }
  }

  if (interaction.commandName === 'delpunishment') {
    const punishId = interaction.options.getString('punishid');
    try {
      await axios.delete(`http://localhost:${PORT}/punishments/${userId}/${punishId}`);
      interaction.reply({ content: `✅ Punishment ${punishId} removed.`, ephemeral: false });
    } catch (error) {
      interaction.reply({ content: '❌ Failed to delete punishment.', ephemeral: false });
    }
  }

  if (interaction.commandName === 'history') {
    try {
      const res = await axios.get(`http://localhost:${PORT}/punishments/${userId}`);
      const list = res.data.map(p => {
        const expires = formatDateToLocaleShort(p.expiresAt, 'en-US');
        return `• **[${p.type.toUpperCase()}]** (ID: \`${p.id}\`) Reason: ${p.reason} | By: ${p.moderator} | Expires: ${expires}`;
      });
      interaction.reply({ content: list.join('\n'), ephemeral: false });
    } catch {
      interaction.reply({ content: '⚠️ No punishments found.', ephemeral: false });
    }
  }
});

client.login(TOKEN);
app.listen(PORT, () => {
  console.log(`API Server running on port ${PORT}`);
});
