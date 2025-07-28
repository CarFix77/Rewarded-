// server.js
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223"
};

// Имитация базы данных
const db = {
  users: {},
  withdrawals: {},
  tasks: [
    {
      id: "follow",
      title: "Подписаться на Telegram",
      description: "Подпишитесь на наш канал",
      reward: 0.10,
      url: "https://t.me/example",
      cooldown: 10
    }
  ]
};

const app = express();
app.use(cors());
app.use(express.json());

// Регистрация пользователя
app.post('/register', (req, res) => {
  try {
    const { refCode } = req.body;
    const userId = `user_${uuidv4()}`;
    const userRefCode = uuidv4().slice(0, 8);

    db.users[userId] = {
      balance: 0,
      refCode: userRefCode,
      refCount: 0,
      refEarnings: 0,
      completedTasks: [],
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
      refCode: userRefCode,
      refLink: `${req.protocol}://${req.get('host')}?ref=${userRefCode}`
    });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// Получение данных пользователя
app.get('/user/:userId', (req, res) => {
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
});

// Просмотр рекламы
app.get('/reward', (req, res) => {
  try {
    const { userid, secret } = req.query;

    if (secret !== CONFIG.SECRET_KEY) {
      return res.status(401).json({ error: "Invalid secret" });
    }

    const today = new Date().toISOString().split('T')[0];
    const user = db.users[userid] || { balance: 0 };
    const dailyViews = user[`views_${today}`] || 0;

    if (dailyViews >= CONFIG.DAILY_LIMIT) {
      return res.status(429).json({ error: "Daily limit reached" });
    }

    const newBalance = user.balance + CONFIG.REWARD_PER_AD;
    db.users[userid] = {
      ...user,
      balance: newBalance,
      [`views_${today}`]: dailyViews + 1
    };

    res.json({
      success: true,
      balance: newBalance,
      viewsToday: dailyViews + 1
    });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// Вывод средств
app.post('/withdraw', (req, res) => {
  try {
    const { userId, wallet, amount } = req.body;
    const user = db.users[userId];

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (amount < CONFIG.MIN_WITHDRAW) {
      return res.status(400).json({ error: `Minimum withdraw: $${CONFIG.MIN_WITHDRAW}` });
    }

    if (user.balance < amount) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const withdrawId = `wd_${uuidv4()}`;
    db.users[userId].balance -= amount;
    db.withdrawals[withdrawId] = {
      userId,
      amount,
      wallet,
      date: new Date().toISOString(),
      status: "pending"
    };

    res.json({ success: true, withdrawId });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// Задания
app.get('/tasks', (req, res) => {
  res.json(db.tasks);
});

// Завершение задания
app.post('/complete-task', (req, res) => {
  try {
    const { userId, taskId } = req.body;
    const user = db.users[userId];
    const task = db.tasks.find(t => t.id === taskId);

    if (!user) return res.status(404).json({ error: "User not found" });
    if (!task) return res.status(404).json({ error: "Task not found" });

    user.balance += task.reward;
    user.completedTasks.push(taskId);

    res.json({ success: true, balance: user.balance });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// Админ-панель
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === CONFIG.ADMIN_PASSWORD) {
    res.json({ token: "admin_" + uuidv4() });
  } else {
    res.status(401).json({ error: "Wrong password" });
  }
});

// Статус сервера
app.get('/', (req, res) => {
  res.json({
    status: "OK",
    endpoints: {
      register: "POST /register",
      reward: "GET /reward?userid=ID&secret=wagner46375",
      withdraw: "POST /withdraw",
      tasks: "GET /tasks"
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
