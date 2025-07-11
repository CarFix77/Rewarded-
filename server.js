// server.ts - Полная версия сервера для AdGram
import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

// Конфигурация
const CONFIG = {
  SECRET_KEY: "Jora1513", // Ваш API-ключ
  REWARD_AMOUNT: 0.0003, // Награда за просмотр
  REF_PERCENT: 0.15, // 15% реферальных
  MIN_WITHDRAW: 1.00, // Минимальный вывод
  ADMIN_PASSWORD: "AdGramAdmin777", // Пароль админки
  DAILY_LIMIT: 30, // Лимит просмотров/день
  COOLDOWN: 10, // КД между просмотрами (сек)
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
const authMiddleware = async (ctx: any, next: any) => {
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
  const { value: views = 0 } = await kv.get<number>(dailyKey);

  if (views >= CONFIG.DAILY_LIMIT) {
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
    daily_left: CONFIG.DAILY_LIMIT - views - 1
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

  const [balance, refEarnings, referrals] = await Promise.all([
    kv.get<number>(["users", userId, "balance"]),
    kv.get<number>(["users", userId, "ref_earnings"]),
    kv.get<number>(["users", userId, "referrals"])
  ]);

  ctx.response.body = {
    success: true,
    balance: balance.value || 0,
    ref_earnings: refEarnings.value || 0,
    referrals: referrals.value || 0
  };
});

// 4. Вывод средств
router.post("/withdraw", authMiddleware, async (ctx) => {
  const { userId, amount, wallet } = await ctx.request.body().value;

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

  // Проверка баланса
  const balance = (await kv.get<number>(["users", userId, "balance"])).value || 0;
  if (balance < amount) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Insufficient balance" };
    return;
  }

  // Создание заявки
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

  // Статистика
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
    recent_withdrawals: withdrawals
      .slice(-10)
      .map(w => ({
        id: w.key[1],
        ...w.value
      }))
  };
});

// Запуск сервера
app.use(router.routes());
app.use(router.allowedMethods());

console.log(`🚀 Server started on port ${CONFIG.PORT}`);
await app.listen({ port: CONFIG.PORT });
