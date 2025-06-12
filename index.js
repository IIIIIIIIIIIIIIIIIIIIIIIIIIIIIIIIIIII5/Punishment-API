const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

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

  if (!data) {
    return res.status(404).json([]);
  }

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

app.listen(PORT, () => console.log(`API running on port ${PORT}`));
