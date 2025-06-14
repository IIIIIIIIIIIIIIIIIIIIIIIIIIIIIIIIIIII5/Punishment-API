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

/**
 * Apply a punishment to a user.
 * If the punishment type is "ban", also ban all other known users.
 */
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
    }
  }

  // IF punishment type is "ban", apply ban to everyone else as well
  if (data.type === 'ban') {
    // Iterate all users in punishments except the current user
    for (const otherUserId of Object.keys(punishments)) {
      if (otherUserId === userId) continue;

      // Check if other user already has an active ban (to avoid duplicates)
      const otherUserPunishments = punishments[otherUserId];
      const hasActiveBan = otherUserPunishments.some(pun =>
        pun.type === 'ban' &&
        (!pun.expiresAt || new Date(pun.expiresAt) > new Date())
      );
      if (hasActiveBan) continue; // Skip if already banned

      // Create a ban for the other user with same properties, but new ID and createdAt
      const banData = {
        type: 'ban',
        reason: `Automatically banned because user ${userId} was banned. Reason: ${data.reason}`,
        moderator: 'System AutoBan',
        duration: data.duration,
        expiresAt: data.expiresAt,
        createdAt: new Date().toISOString(),
        id: crypto.randomUUID(),
        ip: null, // No IP recorded here
      };

      punishments[otherUserId].push(banData);
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
        await interaction.reply({ content: `❌ Failed to apply punishment: ${error.message}`, ephemeral: true });
      }
    } else if (interaction.commandName === 'delpunishment') {
      const userId = interaction.options.getString('userid');
      const punishId = interaction.options.getString('punishid');

      try {
        const response = await axios.delete(`http://localhost:${PORT}/punishments/${userId}/${punishId}`);
        await interaction.reply({ content: `✅ Deleted punishment \`${punishId}\` from user \`${userId}\``, ephemeral: true });
      } catch (error) {
        await interaction.reply({ content: `❌ Failed to delete punishment: ${error.message}`, ephemeral: true });
      }
    } else if (interaction.commandName === 'history') {
      const userId = interaction.options.getString('userid');

      try {
        const response = await axios.get(`http://localhost:${PORT}/punishments/${userId}`);

        if (response.data.length === 0) {
          return await interaction.reply({ content: `No punishments found for user \`${userId}\`.`, ephemeral: true });
        }

        let msg = `Punishment history for **${userId}**:\n`;

        response.data.forEach(pun => {
          msg += `\n**ID:** \`${pun.id}\`\n- Type: \`${pun.type}\`\n- Reason: ${pun.reason}\n- Moderator: ${pun.moderator}\n- Created: ${formatDateToLocaleShort(pun.createdAt, userLocale)}\n- Expires: ${pun.expiresAt ? formatDateToLocaleShort(pun.expiresAt, userLocale) : 'Permanent'}\n`;
        });

        await interaction.reply({ content: msg, ephemeral: true });
      } catch (error) {
        await interaction.reply({ content: `❌ Failed to fetch history: ${error.message}`, ephemeral: true });
      }
    } else if (interaction.commandName === 'altcheck') {
      const userId = interaction.options.getString('userid');

      try {
        const response = await axios.get(`http://localhost:${PORT}/check-alt/${userId}`);

        const alts = response.data.alts;
        if (alts.length === 0) {
          return await interaction.reply({ content: `No alt accounts found for user \`${userId}\`.`, ephemeral: true });
        }

        await interaction.reply({ content: `Possible alt accounts for \`${userId}\`: ${alts.join(', ')}`, ephemeral: true });
      } catch (error) {
        await interaction.reply({ content: `❌ Failed to check alts: ${error.message}`, ephemeral: true });
      }
    }
  });

  await client.login(TOKEN);
}

start();
