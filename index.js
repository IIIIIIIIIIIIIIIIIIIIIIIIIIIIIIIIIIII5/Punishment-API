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

app.post('/punishments/:userId', (req, res) => {
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

    // Ban all users on this IP
    const allUsers = Array.from(ipToUserIds[ip]);
    allUsers.forEach(uid => {
      // Skip if user already has an active ban for that IP
      const userPunishments = punishments[uid] || [];
      const hasIpBan = userPunishments.some(pun => pun.type === 'ipban' && pun.ip === ip);

      if (!hasIpBan) {
        const banData = {
          type: 'ipban',
          reason: `IP ban from associated IP (${ip})`,
          moderator: data.moderator,
          duration: data.duration,
          expiresAt: data.expiresAt,
          createdAt: new Date().toISOString(),
          id: crypto.randomUUID(),
          ip: ip
        };
        if (!punishments[uid]) punishments[uid] = [];
        punishments[uid].push(banData);
      }
    });
  }
}

  res.json({ success: true, id: data.id });
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

      try {
        const response = await axios.post(`http://localhost:${PORT}/punishments/${userId}`, {
          type,
          duration,
          reason,
          moderator
        });

        await interaction.reply({
          content: `✅ Punishment applied to **${userId}**\nType: \`${type}\`\nDuration: \`${duration === 0 ? 'Permanent' : duration + 's'}\`\nReason: ${reason}\nID: \`${response.data.id}\``,
          ephemeral: true
        });
      } catch (error) {
        console.error("Failed to apply punishment:", error.response?.data || error.message || error);
        await interaction.reply({ content: '❌ Failed to apply punishment.', ephemeral: true });
      }
    }

    else if (interaction.commandName === 'delpunishment') {
      const userId = interaction.options.getString('userid');
      const punishId = interaction.options.getString('punishid');

      try {
        await axios.delete(`http://localhost:${PORT}/punishments/${userId}/${punishId}`);

        await interaction.reply({
          content: `✅ Deleted punishment \`${punishId}\` for user **${userId}**.`,
          ephemeral: true
        });
      } catch (error) {
        console.error("Failed to delete punishment:", error.response?.data || error.message || error);
        await interaction.reply({ content: '❌ Failed to delete punishment. Maybe the ID is wrong?', ephemeral: true });
      }
    }

    else if (interaction.commandName === 'history') {
      const userId = interaction.options.getString('userid');

      try {
        const response = await axios.get(`http://localhost:${PORT}/punishments/${userId}`);
        const data = response.data;

        if (!data.length) {
          await interaction.reply({ content: `ℹ No punishment history found for user ID **${userId}**.`, ephemeral: true });
          return;
        }

        const lines = data.map((p, i) => {
          const createdAtFormatted = formatDateToLocaleShort(p.createdAt, userLocale);
          const expiresAtFormatted = p.expiresAt ? formatDateToLocaleShort(p.expiresAt, userLocale) : 'Permanent';
          return `#${i + 1} [${p.type}] ${p.reason} | By: ${p.moderator} | Created: ${createdAtFormatted} | Expires: ${expiresAtFormatted} | ID: \`${p.id}\``;
        }).join('\n');

        const chunks = [];
        const chunkSize = 1900;
        for (let i = 0; i < lines.length; i += chunkSize) {
          chunks.push(lines.substring(i, i + chunkSize));
        }

        await interaction.reply({ content: chunks[0], ephemeral: true });
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i], ephemeral: true });
        }
      } catch (error) {
        console.error("Failed to fetch history:", error.response?.data || error.message || error);
        await interaction.reply({ content: '❌ Failed to get punishment history.', ephemeral: true });
      }
    }

    else if (interaction.commandName === 'altcheck') {
      const userId = interaction.options.getString('userid');

      try {
        const response = await axios.get(`http://localhost:${PORT}/check-alt/${userId}`);
        const alts = response.data.alts;

        if (alts.length === 0) {
          await interaction.reply({ content: `✅ No alt accounts found for user ID **${userId}** based on shared IPs.`, ephemeral: true });
        } else {
          await interaction.reply({ content: `⚠️ Possible alt accounts for user ID **${userId}** (shared IP punishments):\n${alts.map(id => `• ${id}`).join('\n')}`, ephemeral: true });
        }
      } catch (error) {
        console.error("Alt check failed:", error.response?.data || error.message || error);
        await interaction.reply({ content: '❌ Failed to check for alts.', ephemeral: true });
      }
    }
  });

  client.login(TOKEN);
}

start();
