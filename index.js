const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
const crypto = require('crypto');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENTID;
const GUILD_ID = process.env.GUILDID;

const validTypes = ['ban', 'warn', 'toolban', 'kick', 'ipban'];

const bannedIps = new Map();

const punishCommand = new SlashCommandBuilder()
  .setName('punish')
  .setDescription('Apply a punishment to a Roblox user')
  .addStringOption(opt => opt.setName('userid').setDescription('Roblox User ID').setRequired(true))
  .addStringOption(opt => opt.setName('type').setDescription('Type of punishment').setRequired(true).addChoices(
    { name: 'ban', value: 'ban' },
    { name: 'warn', value: 'warn' },
    { name: 'toolban', value: 'toolban' },
    { name: 'kick', value: 'kick' },
    { name: 'ipban', value: 'ipban' }
  ))
  .addIntegerOption(opt => opt.setName('duration').setDescription('Duration in seconds (0 = permanent)').setRequired(true))
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

const altCheckCommand = new SlashCommandBuilder()
  .setName('altcheck')
  .setDescription('Check for possible alt accounts based on IP sharing')
  .addStringOption(opt => opt.setName('userid').setDescription('Roblox User ID').setRequired(true));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let punishments = {};
let deletedPunishments = {};
const ipToUserIds = {};

function formatDateToLocaleShort(dateString, locale) {
  if (!dateString) return 'Permanent';
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return dateString;
  }
}

app.post('/punishments/:userId', async (req, res) => {
  const userId = String(req.params.userId);
  const data = req.body;

  if (!data.type || !data.reason || !data.moderator) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }

  if (!validTypes.includes(data.type)) {
    return res.status(400).json({ success: false, message: "Invalid punishment type" });
  }

  if (data.duration && data.duration > 0) {
    data.expiresAt = new Date(Date.now() + (data.duration * 1000)).toISOString();
  } else {
    data.expiresAt = null;
  }

  data.createdAt = new Date().toISOString();
  data.id = crypto.randomUUID();

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
  data.ip = ip;

  if (!punishments[userId]) punishments[userId] = [];
  punishments[userId].push(data);

  if (ip) {
    if (!ipToUserIds[ip]) ipToUserIds[ip] = new Set();
    ipToUserIds[ip].add(userId);

    if (data.type === 'ipban') {
      bannedIps.set(ip, {
        expiresAt: data.expiresAt,
        userId,
        reason: data.reason,
        id: data.id
      });

      const userIdsOnIp = Array.from(ipToUserIds[ip]);

      for (const otherUserId of userIdsOnIp) {
        if (otherUserId === userId) continue;
        const otherUserPunishments = punishments[otherUserId] || [];
        const alreadyIpBanned = otherUserPunishments.some(pun =>
          pun.type === 'ipban' &&
          (!pun.expiresAt || new Date(pun.expiresAt) > new Date())
        );
        if (alreadyIpBanned) continue;

        const banData = {
          type: 'ipban',
          reason: `Automatically ipbanned due to shared IP with user ${userId}. Reason: ${data.reason}`,
          moderator: 'System AutoIPBan',
          duration: data.duration,
          expiresAt: data.expiresAt,
          createdAt: new Date().toISOString(),
          id: crypto.randomUUID(),
          ip: ip
        };

        if (!punishments[otherUserId]) punishments[otherUserId] = [];
        punishments[otherUserId].push(banData);
      }
    }
  }

  return res.json({ success: true, id: data.id });
});

app.get('/punishments/:userId', (req, res) => {
  const userId = String(req.params.userId);

  const active = punishments[userId] || [];
  const deleted = deletedPunishments[userId] || [];

  const allPunishments = [...active, ...deleted];

  if (allPunishments.length === 0) {
    return res.status(404).json([]);
  }

  res.json(allPunishments);
});

app.delete('/punishments/:userId', (req, res) => {
  const userId = String(req.params.userId);
  delete punishments[userId];
  delete deletedPunishments[userId];
  res.json({ success: true });
});

app.delete('/punishments/:userId/:punishId', (req, res) => {
  const { userId, punishId } = req.params;
  if (!punishments[userId]) return res.status(404).json({ success: false, message: "User not found" });

  const index = punishments[userId].findIndex(p => p.id === punishId);
  if (index === -1) return res.status(404).json({ success: false, message: "Punishment ID not found" });

  const [removed] = punishments[userId].splice(index, 1);

  if (!deletedPunishments[userId]) deletedPunishments[userId] = [];
  deletedPunishments[userId].push(removed);

  res.json({ success: true });
});

app.get('/check-alt/:userId', (req, res) => {
  const userId = String(req.params.userId);

  let userIps = new Set();
  const userPunishments = punishments[userId] || [];
  userPunishments.forEach(pun => {
    if (pun.ip) userIps.add(pun.ip);
  });

  let altUsers = new Set();

  userIps.forEach(ip => {
    const usersWithIp = ipToUserIds[ip];
    if (usersWithIp) {
      usersWithIp.forEach(otherId => {
        if (otherId !== userId) altUsers.add(otherId);
      });
    }
  });

  res.json({ alts: Array.from(altUsers) });
});

app.get('/check-ipban/:ip', (req, res) => {
  const ip = req.params.ip;
  const banInfo = bannedIps.get(ip);
  if (!banInfo) return res.json({ banned: false });

  if (banInfo.expiresAt && new Date(banInfo.expiresAt) < new Date()) {
    bannedIps.delete(ip);
    return res.json({ banned: false });
  }

  res.json({ banned: true, info: banInfo });
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    {
      body: [
        punishCommand.toJSON(),
        delPunishmentCommand.toJSON(),
        historyCommand.toJSON(),
        altCheckCommand.toJSON()
      ]
    }
  );
}

async function start() {
  await registerCommands();

  app.listen(PORT);

  client.once('ready', () => {});

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const userLocale = interaction.locale || 'en-GB';

    if (interaction.commandName === 'punish') {
      const userId = interaction.options.getString('userid');
      const type = interaction.options.getString('type');
      const duration = interaction.options.getInteger('duration');
      const reason = interaction.options.getString('reason');
      const moderator = interaction.user.tag;

      if (!/^\d+$/.test(userId)) {
        await interaction.reply({ content: 'User ID must be numeric.', ephemeral: true });
        return;
      }

      if (!validTypes.includes(type)) {
        await interaction.reply({ content: `Invalid punishment type. Valid types: ${validTypes.join(', ')}`, ephemeral: true });
        return;
      }

      if (duration < 0) {
        await interaction.reply({ content: 'Duration must be zero or greater.', ephemeral: true });
        return;
      }

      try {
        const response = await axios.post(`http://localhost:${PORT}/punishments/${userId}`, {
          type,
          reason,
          moderator,
          duration
        });

        if (response.data.success) {
          await interaction.reply(`✅ Punishment applied! ID: ${response.data.id}`);
        } else {
          await interaction.reply('❌ Failed to apply punishment.');
        }
      } catch {
        await interaction.reply('❌ Error applying punishment.');
      }
    }
    else if (interaction.commandName === 'delpunishment') {
      const userId = interaction.options.getString('userid');
      const punishId = interaction.options.getString('punishid');

      if (!punishments[userId]) {
        await interaction.reply({ content: `No punishments found for user ID ${userId}`, ephemeral: true });
        return;
      }

      const index = punishments[userId].findIndex(p => p.id === punishId);
      if (index === -1) {
        await interaction.reply({ content: 'Punishment ID not found.', ephemeral: true });
        return;
      }

      punishments[userId].splice(index, 1);
      if (!deletedPunishments[userId]) deletedPunishments[userId] = [];
      deletedPunishments[userId].push({ id: punishId, deletedBy: interaction.user.tag, deletedAt: new Date().toISOString() });

      await interaction.reply(`✅ Punishment ID ${punishId} removed.`);
    }
    else if (interaction.commandName === 'history') {
      const userId = interaction.options.getString('userid');

      const userPunishments = punishments[userId] || [];
      const userDeleted = deletedPunishments[userId] || [];

      if (userPunishments.length + userDeleted.length === 0) {
        await interaction.reply({ content: `No punishments found for user ID ${userId}`, ephemeral: true });
        return;
      }

      let reply = `**Punishment history for user ID ${userId}:**\n`;
      const allPunishments = [...userPunishments, ...userDeleted];

      for (const p of allPunishments) {
        reply += `• ID: ${p.id} | Type: ${p.type} | Reason: ${p.reason} | Moderator: ${p.moderator || p.deletedBy || 'N/A'} | Expires: ${formatDateToLocaleShort(p.expiresAt, userLocale)}\n`;
      }

      if (reply.length > 2000) {
        reply = reply.slice(0, 1997) + '...';
      }

      await interaction.reply({ content: reply, ephemeral: true });
    }
    else if (interaction.commandName === 'altcheck') {
      const userId = interaction.options.getString('userid');

      const userIps = new Set();
      (punishments[userId] || []).forEach(p => { if (p.ip) userIps.add(p.ip); });

      const altUsers = new Set();

      userIps.forEach(ip => {
        const users = ipToUserIds[ip];
        if (users) users.forEach(u => { if (u !== userId) altUsers.add(u); });
      });

      if (altUsers.size === 0) {
        await interaction.reply(`No alt accounts found for user ID ${userId}.`);
      } else {
        await interaction.reply(`Possible alt accounts for user ID ${userId}: ${Array.from(altUsers).join(', ')}`);
      }
    }
  });

  client.login(TOKEN);
}

start();
