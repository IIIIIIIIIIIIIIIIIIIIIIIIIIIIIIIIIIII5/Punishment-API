const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

let punishments = {};

app.post('/punishments/:userId', (req, res) => {
  const userId = req.params.userId;
  const data = req.body;
  data.createdAt = Date.now();
  punishments[userId] = data;
  res.json({ success: true });
});

app.get('/punishments/:userId', (req, res) => {
  const userId = req.params.userId;
  const data = punishments[userId];

  if (!data) return res.status(404).json({ error: 'No punishment found' });

  if (data.expiresAt && Date.now() > data.expiresAt) {
    delete punishments[userId];
    return res.status(404).json({ error: 'Punishment expired' });
  }

  res.json(data);
});

app.delete('/punishments/:userId', (req, res) => {
  const userId = req.params.userId;
  delete punishments[userId];
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`API running on port ${PORT}`));
