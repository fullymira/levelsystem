require('dotenv').config();
const express = require('express');
const axios = require('axios');
const tmi = require('tmi.js');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Twitch Chat verbinden
const client = new tmi.Client({
  identity: {
    username: process.env.TWITCH_USERNAME,
    password: process.env.TWITCH_OAUTH
  },
  channels: [process.env.TWITCH_CHANNEL]
});
client.connect();

client.on('message', (channel, tags, message, self) => {
  if (self) return;
  console.log(`[CHAT] ${tags.username}: ${message}`);
});

// EventSub Webhook
app.post('/eventsub', (req, res) => {
  const msgId = req.header('Twitch-Eventsub-Message-Id');
  const timestamp = req.header('Twitch-Eventsub-Message-Timestamp');
  const signature = req.header('Twitch-Eventsub-Message-Signature');
  const body = JSON.stringify(req.body);
  const secret = process.env.WEBHOOK_SECRET;

  const hmac = crypto.createHmac('sha256', secret);
  const expected = 'sha256=' + hmac.update(msgId + timestamp + body).digest('hex');
  if (signature !== expected) return res.status(403).send('Invalid signature');

  const { type, event, challenge } = req.body;

  if (req.header('Twitch-Eventsub-Message-Type') === 'webhook_callback_verification') {
    return res.status(200).send(challenge);
  }

  console.log(`[EVENT] ${type} ->`, event);
  res.status(200).end();
});

// Twitch User-ID abrufen
async function getUserId(username) {
  const res = await axios.get('https://api.twitch.tv/helix/users', {
    headers: {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      Authorization: process.env.TWITCH_OAUTH
    },
    params: { login: username }
  });

  return res.data.data[0]?.id;
}

// Token aktualisieren + EventSub registrieren
async function refreshToken() {
  try {
    const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        grant_type: 'refresh_token',
        refresh_token: process.env.TWITCH_REFRESH_TOKEN,
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET
      }
    });

    process.env.TWITCH_OAUTH = `Bearer ${res.data.access_token}`;
    process.env.TWITCH_REFRESH_TOKEN = res.data.refresh_token;

    console.log('🔄 Token aktualisiert');
    await registerEventSubs();

  } catch (err) {
    console.error('❌ Fehler beim Token:', err.response?.data || err.message);
  }
}

// EventSub Registrierung
async function registerEventSubs() {
  const events = [
  'channel.subscribe',
  'channel.subscription.gift',
  'channel.cheer',
  'channel.channel_points_custom_reward_redemption.add',
  'channel.hype_train.begin',
  'channel.hype_train.progress',
  'channel.hype_train.end',
  'channel.raid',
  'stream.online',
  'stream.offline'
];


  try {
    const broadcasterId = await getUserId(process.env.TWITCH_CHANNEL);

    const auth = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        grant_type: 'client_credentials',
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET
      }
    });

    const headers = {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${auth.data.access_token}`,
      'Content-Type': 'application/json'
    };

    for (const type of events) {
      await axios.post('https://api.twitch.tv/helix/eventsub/subscriptions', {
        type,
        version: '1',
        condition: { broadcaster_user_id: broadcasterId },
        transport: {
          method: 'webhook',
          callback: process.env.WEBHOOK_URL,
          secret: process.env.WEBHOOK_SECRET
        }
      }, { headers });

      console.log(`📡 Registriert: ${type}`);
    }

  } catch (err) {
    console.error('❌ Fehler bei EventSub:', err.response?.data || err.message);
  }
}

// Render-Port verwenden
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
  refreshToken();
  setInterval(refreshToken, 60 * 60 * 1000); // alle 60 Minuten
});
