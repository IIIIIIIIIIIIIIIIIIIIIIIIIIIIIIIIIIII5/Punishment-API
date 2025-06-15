const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
const crypto = require('crypto');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENTID;
const GUILD_ID = process.env.GUILDID;

const validTypes = ['ban', 'warn', 'toolban', 'kick'];

const punishCommand = new SlashCommandBuilder()
  .setName('punish')
  .setDescription('Apply a punishment to a Roblox user')
  .addStringOption(opt => opt.setName('userid').setDescription('Roblox User ID').setRequired(true))
  .addStringOption(opt => opt.setName('type').setDescription('Type of punishment').setRequired(true).addChoices(
    { name: 'ban', value: 'ban' },
    { name: 'warn', value: 'warn' },
    { name: 'toolban', value: 'toolban' },
    { name: 'kick', value: 'kick' },
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

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let punishments = {};
let deletedPunishments = {};

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

  if (!punishments[userId]) punishments[userId] = [];
  punishments[userId].push(data);

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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    {
      body: [
        punishCommand.toJSON(),
        delPunishmentCommand.toJSON(),
        historyCommand.toJSON()
      ]
    }
  );
}

async function start() {
  await registerCommands();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  client.once('ready', () => {
    console.log('Discord bot is ready.');
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
      } catch (err) {
        await interaction.reply('❌ Error occurred while applying punishment.');
      }
    }

    if (interaction.commandName === 'delpunishment') {
      const userId = interaction.options.getString('userid');
      const punishId = interaction.options.getString('punishid');

      try {
        const response = await axios.delete(`http://localhost:${PORT}/punishments/${userId}/${punishId}`);
        if (response.data.success) {
          await interaction.reply('✅ Punishment removed.');
        } else {
          await interaction.reply('❌ Failed to remove punishment.');
        }
      } catch {
        await interaction.reply('❌ Error occurred while deleting punishment.');
      }
    }

    if (interaction.commandName === 'history') {
      const userId = interaction.options.getString('userid');

      try {
        const response = await axios.get(`http://localhost:${PORT}/punishments/${userId}`);
        const data = response.data;

        if (!Array.isArray(data) || data.length === 0) {
          await interaction.reply(`No punishment history for user ID ${userId}.`);
          return;
        }

        const historyText = data.map(p => {
          const date = formatDateToLocaleShort(p.createdAt, userLocale);
          const until = formatDateToLocaleShort(p.expiresAt, userLocale);
          return `• **${p.type}** on ${date} - Reason: *${p.reason}* - Until: ${until}`;
        }).join('\n');

        await interaction.reply(`📄 **Punishment History for ${userId}:**\n${historyText}`);
      } catch {
        await interaction.reply('❌ Failed to fetch history.');
      }
    }
  });

  await client.login(TOKEN);
}

start();
