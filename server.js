// server.js - Полная рабочая версия для Deno Deploy
import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

// Конфигурация
const CONFIG = {
  SECRET_KEY: "Jora1513",
  REWARD_AMOUNT: 0.0003,
  REF_PERCENT: 0.15,
  MIN_WITHDRAW: 1.00,
  ADMIN_PASSWORD: "AdGramAdmin777",
  DAILY_LIMIT: 30,
  COOLDOWN: 10,
  PORT: 8000
};

// Инициализация
const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Middleware
app.use(oakCors({ origin: "*" }));
app.use(async (ctx, next) => {
  ctx.response.headers.set("Content-Type", "application/json");
  try {
    await next();
  } catch (err) {
    console.error(err);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Проверка авторизации
const authMiddleware = async (ctx, next) => {
  const publicRoutes = ["/", "/health"];
  if (publicRoutes.includes(ctx.request.url.pathname)) return await next();
  
  const key = ctx.request.url.searchParams.get("key") || ctx.request.headers.get("x-api-key");
  if (key !== CONFIG.SECRET_KEY && !ctx.request.url.pathname.startsWith("/admin")) {
    ctx.response.status = 403;
    ctx.response.body = { error: "Invalid API key" };
    return;
  }
  await next();
};

// API Endpoints

// 1. Главная страница
router.get("/", (ctx) => {
  ctx.response.body = {
    app: "AdGram Reward System",
    version: "1.0.0",
    endpoints: {
      reward: "/reward?userid=ID&key=API_KEY&ref=REF_ID",
      balance: "/balance?userid=ID&key=API_KEY",
      withdraw: "POST /withdraw {userId, amount, wallet}",
      admin: "/admin?password=ADMIN_PASS"
    }
  };
});

// 2. Награда за просмотр
router.get("/reward", authMiddleware, async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  const refId = ctx.request.url.searchParams.get("ref");

  if (!userId) {
    ctx.response.status = 400;
    ctx.response.body = { error: "userid is required" };
    return;
  }

  // Проверка дневного лимита
  const today = new Date().toISOString().split("T")[0];
  const dailyKey = ["daily", userId, today];
  const dailyViews = (await kv.get(dailyKey)).value || 0;

  if (dailyViews >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { error: "Daily limit reached" };
    return;
  }

  // Начисление награды
  const tx = kv.atomic()
    .sum(["users", userId, "balance"], CONFIG.REWARD_AMOUNT)
    .sum(dailyKey, 1);

  // Реферальное начисление
  if (refId && refId !== userId) {
    const refReward = CONFIG.REWARD_AMOUNT * CONFIG.REF_PERCENT;
    tx
      .sum(["users", refId, "balance"], refReward)
      .sum(["users", refId, "ref_earnings"], refReward)
      .sum(["users", refId, "referrals"], 1);
  }

  await tx.commit();

  ctx.response.body = {
    success: true,
    reward: CONFIG.REWARD_AMOUNT,
    daily_left: CONFIG.DAILY_LIMIT - dailyViews - 1
  };
});

// 3. Проверка баланса
router.get("/balance", authMiddleware, async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  
  if (!userId) {
    ctx.response.status = 400;
    ctx.response.body = { error: "userid is required" };
    return;
  }

  const balance = (await kv.get(["users", userId, "balance"])).value || 0;
  const refEarnings = (await kv.get(["users", userId, "ref_earnings"])).value || 0;
  const referrals = (await kv.get(["users", userId, "referrals"])).value || 0;

  ctx.response.body = {
    success: true,
    balance: balance,
    ref_earnings: refEarnings,
    referrals: referrals
  };
});

// 4. Вывод средств
router.post("/withdraw", authMiddleware, async (ctx) => {
  const body = await ctx.request.body().value;
  const userId = body.userId;
  const amount = parseFloat(body.amount);
  const wallet = body.wallet;

  if (!userId || !amount || !wallet) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Missing required fields" };
    return;
  }

  if (amount < CONFIG.MIN_WITHDRAW) {
    ctx.response.status = 400;
    ctx.response.body = { error: `Minimum withdraw is $${CONFIG.MIN_WITHDRAW}` };
    return;
  }

  const balance = (await kv.get(["users", userId, "balance"])).value || 0;
  if (balance < amount) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Insufficient balance" };
    return;
  }

  const withdrawalId = crypto.randomUUID();
  const tx = kv.atomic()
    .set(["withdrawals", withdrawalId], {
      userId,
      amount,
      wallet,
      status: "pending",
      date: new Date().toISOString()
    })
    .sum(["users", userId, "balance"], -amount);

  if (!(await tx.commit()).ok) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Withdrawal failed" };
    return;
  }

  ctx.response.body = {
    success: true,
    withdrawalId,
    newBalance: balance - amount
  };
});

// 5. Админ-панель
router.get("/admin", async (ctx) => {
  const password = ctx.request.url.searchParams.get("password");
  
  if (password !== CONFIG.ADMIN_PASSWORD) {
    ctx.response.status = 403;
    ctx.response.body = { error: "Access denied" };
    return;
  }

  const users = [];
  for await (const entry of kv.list({ prefix: ["users"] })) {
    users.push(entry);
  }

  const withdrawals = [];
  for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
    withdrawals.push(entry);
  }

  ctx.response.body = {
    total_users: users.length,
    total_balance: users.reduce((sum, user) => sum + (user.value.balance || 0), 0),
    pending_withdrawals: withdrawals.filter(w => w.value.status === "pending").length,
    recent_withdrawals: withdrawals.slice(-5).map(w => ({
      id: w.key[1],
      amount: w.value.amount,
      wallet: w.value.wallet,
      status: w.value.status,
      date: w.value.date
    }))
  };
});

// Запуск сервера
app.use(router.routes());
app.use(router.allowedMethods());

console.log(`Server running on port ${CONFIG.PORT}`);
await app.listen({ port: CONFIG.PORT });
