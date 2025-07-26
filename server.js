const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  WEBHOOK_SECRET: "wagner1080",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223"
};

// Имитация базы данных
const db = {
  users: {},
  withdrawals: {},
  views: {},
  tasks: []
};

const app = express();
app.use(cors());
app.use(express.json());

// Middleware для проверки админ-авторизации
const adminAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer admin_')) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

// Регистрация пользователя
app.post('/register', (req, res) => {
  const { refCode } = req.body;
  const userId = `user_${uuidv4()}`;
  const userRefCode = Math.random().toString(36).substr(2, 8).toUpperCase();

  db.users[userId] = {
    balance: 0,
    refCode: userRefCode,
    refCount: 0,
    refEarnings: 0,
    createdAt: new Date().toISOString()
  };

  // Реферальный бонус
  if (refCode) {
    for (const [id, user] of Object.entries(db.users)) {
      if (user.refCode === refCode) {
        const bonus = CONFIG.REWARD_PER_AD * CONFIG.REFERRAL_PERCENT;
        db.users[id] = {
          ...user,
          refCount: user.refCount + 1,
          refEarnings: user.refEarnings + bonus,
          balance: user.balance + bonus
        };
        break;
      }
    }
  }

  res.json({
    userId,
    refCode: userRefCode
  });
});

// Просмотр рекламы
app.get('/reward', (req, res) => {
  const { userid, secret } = req.query;

  if (secret !== CONFIG.SECRET_KEY && secret !== CONFIG.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Invalid secret" });
  }

  const today = new Date().toISOString().split('T')[0];
  const user = db.users[userid] || { balance: 0 };
  const dailyViews = db.views[`${userid}_${today}`] || 0;

  if (dailyViews >= CONFIG.DAILY_LIMIT) {
    return res.status(429).json({ error: "Daily limit reached" });
  }

  const newBalance = user.balance + CONFIG.REWARD_PER_AD;
  db.users[userid] = { ...user, balance: newBalance };
  db.views[`${userid}_${today}`] = dailyViews + 1;

  res.json({
    success: true,
    reward: CONFIG.REWARD_PER_AD,
    balance: newBalance,
    viewsToday: dailyViews + 1
  });
});

// Вывод средств
app.post('/withdraw', (req, res) => {
  const { userId, wallet, amount } = req.body;
  const user = db.users[userId];

  if (!user || amount < CONFIG.MIN_WITHDRAW || user.balance < amount) {
    return res.status(400).json({ error: "Invalid withdrawal" });
  }

  const withdrawId = `wd_${uuidv4()}`;
  db.users[userId].balance -= amount;
  db.withdrawals[withdrawId] = {
    id: withdrawId,
    userId,
    amount,
    wallet,
    date: new Date().toISOString(),
    status: "pending"
  };

  res.json({ success: true, withdrawId });
});

// Админ-авторизация
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === CONFIG.ADMIN_PASSWORD) {
    res.json({ 
      success: true, 
      token: `admin_${uuidv4()}`
    });
  } else {
    res.status(401).json({ error: "Wrong password" });
  }
});

// Получение заявок на вывод
app.get('/admin/withdrawals', adminAuth, (req, res) => {
  const { status = 'pending' } = req.query;
  const withdrawals = Object.values(db.withdrawals)
    .filter(w => w.status === status);
  res.json(withdrawals);
});

// Обработка заявки на вывод
app.put('/admin/withdrawals/:id', adminAuth, (req, res) => {
  const { status } = req.body;
  const withdrawal = db.withdrawals[req.params.id];

  if (!withdrawal) {
    return res.status(404).json({ error: "Not found" });
  }

  db.withdrawals[req.params.id] = {
    ...withdrawal,
    status,
    processedAt: new Date().toISOString()
  };

  res.json({ success: true });
});

// Запуск сервера
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
