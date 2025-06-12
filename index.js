const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENTID;
const GUILD_ID = process.env.SERVERID;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

let punishments = {};

app.post('/punishments/:userId', (req, res) => {
  const userId = String(req.params.userId);
  const data = req.body;

  if (!data.type || !data.reason || !data.moderator) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }

  if (data.duration) {
    data.expiresAt = new Date(Date.now() + (data.duration * 1000)).toISOString();
    delete data.duration;
  }

  data.createdAt = new Date().toISOString();
  punishments[userId] = data;

  res.json({ success: true });
});

app.get('/punishments/:userId', (req, res) => {
  const userId = String(req.params.userId);
  const data = punishments[userId];

  if (!data) return res.status(404).json([]);

  const now = new Date();

  if (data.expiresAt && now > new Date(data.expiresAt)) {
    delete punishments[userId];
    return res.status(404).json([]);
  }

  res.json([data]);
});

app.delete('/punishments/:userId', (req, res) => {
  const userId = String(req.params.userId);
  delete punishments[userId];
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`✅ API running on port ${PORT}`));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const punishCommand = new SlashCommandBuilder()
  .setName('punish')
  .setDescription('Apply a punishment to a Roblox user')
  .addStringOption(opt => opt.setName('userid').setDescription('Roblox User ID').setRequired(true))
  .addStringOption(opt => opt.setName('type').setDescription('Type of punishment').setRequired(true).addChoices(
    { name: 'ban', value: 'ban' },
    { name: 'suspend', value: 'suspend' }
  ))
  .addIntegerOption(opt => opt.setName('duration').setDescription('Duration in seconds (0 = permanent)').setRequired(true))
  .addStringOption(opt => opt.setName('reason').setDescription('Reason for punishment').setRequired(true));

client.once('ready', async () => {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [punishCommand.toJSON()] });
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'punish') return;

  const userId = interaction.options.getString('userid');
  const type = interaction.options.getString('type');
  const duration = interaction.options.getInteger('duration');
  const reason = interaction.options.getString('reason');
  const moderator = interaction.user.tag;

  try {
    const res = await axios.post(`http://localhost:${PORT}/punishments/${userId}`, {
      type,
      duration,
      reason,
      moderator
    });

    await interaction.reply({
      content: `✅ Punishment applied to **${userId}**\nType: \`${type}\`\nDuration: \`${duration === 0 ? 'Permanent' : duration + 's'}\`\nReason: ${reason}`,
      ephemeral: true
    });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    await interaction.reply({ content: '❌ Failed to apply punishment.', ephemeral: true });
  }
});

client.login(TOKEN);
