const express = require('express');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15
};

// Имитация KV-хранилища Deno
const db = {
  users: new Map(),
  views: new Map(),
  withdrawals: new Map()
};

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Генерация ID
function generateId() {
  return uuidv4();
}

// API Endpoints
app.post('/api/register', (req, res) => {
  try {
    const { refCode } = req.body;
    const userId = `user_${generateId()}`;
    const userRefCode = generateId();

    db.users.set(userId, {
      balance: 0,
      refCode: userRefCode,
      refCount: 0,
      refEarnings: 0,
      createdAt: new Date().toISOString()
    });

    // Реферальная система
    if (refCode) {
      for (const [id, user] of db.users.entries()) {
        if (user.refCode === refCode) {
          const bonus = CONFIG.REWARD_PER_AD * CONFIG.REFERRAL_PERCENT;
          db.users.set(id, {
            ...user,
            refCount: user.refCount + 1,
            refEarnings: user.refEarnings + bonus,
            balance: user.balance + bonus
          });
          break;
        }
      }
    }

    res.json({
      success: true,
      userId,
      refCode: userRefCode,
      refLink: `${req.headers.host}?ref=${userRefCode}`
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get('/api/reward', (req, res) => {
  try {
    const { userid, secret } = req.query;

    if (!userid || !secret) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    if (secret !== CONFIG.SECRET_KEY) {
      return res.status(401).json({ error: "Invalid secret" });
    }

    const today = new Date().toISOString().split('T')[0];
    const user = db.users.get(userid);
    const dailyKey = `${userid}|${today}`;
    const dailyViews = db.views.get(dailyKey) || 0;

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (dailyViews >= CONFIG.DAILY_LIMIT) {
      return res.status(429).json({ error: "Daily limit reached" });
    }

    const newBalance = user.balance + CONFIG.REWARD_PER_AD;
    db.users.set(userid, { ...user, balance: newBalance });
    db.views.set(dailyKey, dailyViews + 1);

    res.json({
      success: true,
      reward: CONFIG.REWARD_PER_AD,
      balance: newBalance,
      viewsToday: dailyViews + 1
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Обслуживание фронтенда
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Запуск сервера
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
