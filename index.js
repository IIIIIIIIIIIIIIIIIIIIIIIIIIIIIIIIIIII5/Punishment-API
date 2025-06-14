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
  console.log('✅ Commands registered.');

  app.listen(PORT, () => {
    console.log(`✅ API running on port ${PORT}`);
  });

  client.once('ready', () => {
    console.log(`✅ Discord bot logged in as ${client.user.tag}`);
  });

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
      } catch (error) {
        await interaction.reply('❌ Error applying punishment.');
        console.error(error);
      }
    }
    else if (interaction.commandName === 'delpunishment') {
      const userId = interaction.options.getString('userid');
      const punishId = interaction.options.getString('punishid');
      const moderator = interaction.user.tag;

      try {
        const response = await axios.delete(`http://localhost:${PORT}/punishments/${userId}/${punishId}`);
        if (response.data.success) {
          await interaction.reply(`✅ Punishment ID ${punishId} deleted for user ${userId}.`);
        } else {
          await interaction.reply('❌ Failed to delete punishment.');
        }
      } catch (error) {
        await interaction.reply('❌ Error deleting punishment.');
        console.error(error);
      }
    }
    else if (interaction.commandName === 'history') {
      const userId = interaction.options.getString('userid');

      try {
        const response = await axios.get(`http://localhost:${PORT}/punishments/${userId}`);
        const data = response.data;

        if (!data || data.length === 0) {
          await interaction.reply('No punishments found.');
          return;
        }

        let replyText = `Punishments for User ID ${userId}:\n`;
        data.forEach(pun => {
          replyText += `• ID: ${pun.id}\n  Type: ${pun.type}\n  Reason: ${pun.reason}\n  Moderator: ${pun.moderator}\n  Expires: ${formatDateToLocaleShort(pun.expiresAt, userLocale)}\n  Created: ${formatDateToLocaleShort(pun.createdAt, userLocale)}\n\n`;
        });

        if (replyText.length > 2000) replyText = replyText.slice(0, 1997) + '...';

        await interaction.reply(replyText);
      } catch (error) {
        await interaction.reply('❌ Error fetching punishment history.');
        console.error(error);
      }
    }
    else if (interaction.commandName === 'altcheck') {
      const userId = interaction.options.getString('userid');

      try {
        const response = await axios.get(`http://localhost:${PORT}/check-alt/${userId}`);
        const alts = response.data.alts;

        if (!alts || alts.length === 0) {
          await interaction.reply('No alternate accounts found.');
          return;
        }

        await interaction.reply(`Possible alternate accounts sharing IP:\n${alts.join(', ')}`);
      } catch (error) {
        await interaction.reply('❌ Error fetching alt accounts.');
        console.error(error);
      }
    }
  });

  client.login(TOKEN);
}

start();
