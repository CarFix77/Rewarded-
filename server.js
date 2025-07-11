import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

// Конфигурация
const CONFIG = {
  rewardAmount: 0.0003,
  minWithdraw: 1.00,
  adminPassword: "8223Nn8223",
  apiKey: "SECRET_API_KEY_123", // Замените на ваш реальный ключ
  port: 8000
};

// База данных в памяти
const db: {
  users: Record<string, {
    balance: number;
    lastRewardTime: number;
    withdrawals: Array<{
      id: string;
      amount: number;
      wallet: string;
      status: string;
      date: string;
    }>;
  }>;
} = {
  users: {}
};

// Инициализация сервера
const app = new Application();
const router = new Router();

// Middleware
app.use(oakCors());
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error(err);
    ctx.response.body = { error: "Internal server error" };
    ctx.response.status = 500;
  }
});

// Вспомогательные функции
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// API Endpoints
router.get("/", (ctx) => {
  ctx.response.body = {
    app: "AdGram Reward Server",
    endpoints: {
      reward: "/reward?userid=ID&key=API_KEY",
      balance: "/balance?userid=ID&key=API_KEY",
      withdraw: "POST /withdraw {userId, amount, wallet}",
      admin: "/admin?password=ADMIN_PASS"
    }
  };
});

// Получить награду
router.get("/reward", (ctx) => {
  const { userid, key } = ctx.request.url.searchParams;

  if (key !== CONFIG.apiKey) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid API key" };
    return;
  }

  if (!userid) {
    ctx.response.status = 400;
    ctx.response.body = { error: "User ID is required" };
    return;
  }

  if (!db.users[userid]) {
    db.users[userid] = {
      balance: 0,
      lastRewardTime: 0,
      withdrawals: []
    };
  }

  const user = db.users[userid];
  const now = Date.now();
  const cooldown = 10 * 1000; // 10 секунд

  if (now - user.lastRewardTime < cooldown) {
    ctx.response.status = 429;
    ctx.response.body = { error: "Reward cooldown. Try again later." };
    return;
  }

  user.balance += CONFIG.rewardAmount;
  user.lastRewardTime = now;

  ctx.response.body = {
    success: true,
    reward: CONFIG.rewardAmount,
    newBalance: user.balance
  };
});

// Проверить баланс
router.get("/balance", (ctx) => {
  const { userid, key } = ctx.request.url.searchParams;

  if (key !== CONFIG.apiKey) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid API key" };
    return;
  }

  if (!userid) {
    ctx.response.status = 400;
    ctx.response.body = { error: "User ID is required" };
    return;
  }

  if (!db.users[userid]) {
    db.users[userid] = {
      balance: 0,
      lastRewardTime: 0,
      withdrawals: []
    };
  }

  ctx.response.body = {
    balance: db.users[userid].balance
  };
});

// Запрос на вывод
router.post("/withdraw", async (ctx) => {
  const { userId, amount, wallet } = await ctx.request.body().value;

  if (!userId || !amount || !wallet) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Missing required fields" };
    return;
  }

  if (!db.users[userId]) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User not found" };
    return;
  }

  if (amount < CONFIG.minWithdraw) {
    ctx.response.status = 400;
    ctx.response.body = { error: `Minimum withdrawal is $${CONFIG.minWithdraw}` };
    return;
  }

  if (amount > db.users[userId].balance) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Insufficient balance" };
    return;
  }

  const withdrawal = {
    id: generateId(),
    amount: parseFloat(amount.toFixed(2)),
    wallet,
    status: "pending",
    date: new Date().toISOString()
  };

  db.users[userId].balance -= amount;
  db.users[userId].withdrawals.push(withdrawal);

  ctx.response.body = {
    success: true,
    withdrawalId: withdrawal.id,
    newBalance: db.users[userId].balance
  };
});

// Админ-панель
router.get("/admin", (ctx) => {
  const { password } = ctx.request.url.searchParams;

  if (password !== CONFIG.adminPassword) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid admin password" };
    return;
  }

  ctx.response.body = {
    totalUsers: Object.keys(db.users).length,
    totalBalance: Object.values(db.users).reduce((sum, user) => sum + user.balance, 0),
    pendingWithdrawals: Object.values(db.users)
      .flatMap(user => user.withdrawals)
      .filter(w => w.status === "pending")
  };
});

// Запуск сервера
app.use(router.routes());
app.use(router.allowedMethods());

console.log(`Server running on http://localhost:${CONFIG.port}`);
await app.listen({ port: CONFIG.port });
