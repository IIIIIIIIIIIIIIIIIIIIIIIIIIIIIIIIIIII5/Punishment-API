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
  const units = { y: 31536000, w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
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

app.get('/punishments/:userId', (req, res) => {
  const userId = String(req.params.userId);
  const userPunishments = punishments[userId] || [];
  res.json(userPunishments);
});

app.post('/punishments/:userId', (req, res) => {
  const userId = String(req.params.userId);
  const { type, reason, moderator, duration } = req.body;
  if (!type || !reason || !moderator || !validTypes.includes(type)) {
    return res.status(400).json({ success: false, message: 'Invalid input' });
  }

  const durationSeconds = parseInt(duration);
  const expiresAt = durationSeconds > 0 ? new Date(Date.now() + durationSeconds * 1000).toISOString() : null;
  const id = crypto.randomUUID();
  const data = { id, type, reason, moderator, duration: durationSeconds, expiresAt };

  punishments[userId] = punishments[userId] || [];
  punishments[userId].push(data);

  res.json({ success: true, id });
});

app.delete('/punishments/:userId/:punishId', (req, res) => {
  const userId = String(req.params.userId);
  const punishId = String(req.params.punishId);
  if (!punishments[userId]) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  const before = punishments[userId].length;
  punishments[userId] = punishments[userId].filter(p => p.id !== punishId);
  const after = punishments[userId].length;

  if (before === after) {
    return res.status(404).json({ success: false, message: 'Punishment not found' });
  }

  res.json({ success: true, message: 'Punishment deleted' });
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => { console.log('Bot online'); });

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: [punishCommand, delPunishmentCommand, historyCommand],
  });
  client.login(TOKEN);
})();

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.options.getString('userid');
  if (interaction.commandName === 'punish') {
    const type = interaction.options.getString('type');
    const duration = interaction.options.getString('duration');
    const reason = interaction.options.getString('reason');
    const durationSec = parseDuration(duration);
    if (durationSec === null && duration !== '0') {
      return interaction.reply({ content: 'Invalid duration format.', ephemeral: true });
    }

    const payload = {
      type,
      reason,
      moderator: interaction.user.tag,
      duration: duration === '0' ? 0 : durationSec,
    };

    try {
      const res = await axios.post(`http://localhost:${PORT}/punishments/${userId}`, payload);
      interaction.reply({ content: `Punishment applied. ID: ${res.data.id}`, ephemeral: true });
    } catch {
      interaction.reply({ content: 'Failed to apply punishment.', ephemeral: true });
    }
  }

  if (interaction.commandName === 'delpunishment') {
    const punishId = interaction.options.getString('punishid');
    try {
      await axios.delete(`http://localhost:${PORT}/punishments/${userId}/${punishId}`);
      interaction.reply({ content: 'Punishment deleted.', ephemeral: true });
    } catch {
      interaction.reply({ content: 'Failed to delete punishment.', ephemeral: true });
    }
  }

  if (interaction.commandName === 'history') {
    try {
      const res = await axios.get(`http://localhost:${PORT}/punishments/${userId}`);
      const data = res.data;
      if (!data.length) return interaction.reply({ content: 'No punishments found.', ephemeral: true });

      const lines = data.map(p => `**ID:** ${p.id}\n**Type:** ${p.type}\n**Reason:** ${p.reason}\n**Moderator:** ${p.moderator}\n**Expires:** ${p.expiresAt || 'Permanent'}`);
      interaction.reply({ content: lines.join('\n\n'), ephemeral: true });
    } catch {
      interaction.reply({ content: 'Failed to fetch history.', ephemeral: true });
    }
  }
});

client.login(TOKEN);
app.listen(PORT);
