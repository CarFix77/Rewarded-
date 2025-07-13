import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const CONFIG = {
  SECRET_KEY: "Jora1513",
  REWARD_AMOUNT: 0.0003,
  REF_PERCENT: 0.15,
  MIN_WITHDRAW: 1.00,
  ADMIN_PASSWORD: "AdGramAdmin777",
  DAILY_LIMIT: 30,
  COOLDOWN: 10
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// CORS настройки
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"]
}));

// Генерация реферального кода
function generateRefCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

// ========== РОУТЫ ДЛЯ ПОЛЬЗОВАТЕЛЕЙ ========== //

// Регистрация
router.post("/api/register", async (ctx) => {
  const { refCode } = await ctx.request.body().value;
  const userId = "user_" + crypto.randomUUID();
  const userRefCode = generateRefCode();

  await kv.set(["users", userId], {
    balance: 0,
    refCode: userRefCode,
    refEarnings: 0,
    refCount: 0,
    createdAt: new Date().toISOString()
  });

  // Если есть реферальный код
  if (refCode) {
    for await (const entry of kv.list({ prefix: ["users"] })) {
      if (entry.value.refCode === refCode) {
        await kv.set(["refs", refCode, userId], { date: new Date().toISOString() });
        break;
      }
    }
  }

  ctx.response.body = { userId, refCode: userRefCode };
});

// Просмотр рекламы
router.post("/api/watch-ad", async (ctx) => {
  const { userId, adType } = await ctx.request.body().value;
  const today = new Date().toISOString().split("T")[0];
  
  // Проверка лимита
  const dailyViews = await kv.get(["stats", userId, today]);
  if (dailyViews.value >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { error: "Daily limit reached" };
    return;
  }

  // Начисление
  const reward = CONFIG.REWARD_AMOUNT;
  await kv.atomic()
    .sum(["users", userId, "balance"], reward)
    .sum(["stats", userId, today], 1)
    .commit();

  // Реферальное начисление
  const refs = [];
  for await (const entry of kv.list({ prefix: ["refs", userId] })) {
    const refUserId = entry.key[2];
    const refReward = reward * CONFIG.REF_PERCENT;
    await kv.atomic()
      .sum(["users", refUserId, "balance"], refReward)
      .sum(["users", refUserId, "refEarnings"], refReward)
      .commit();
    refs.push(refUserId);
  }

  ctx.response.body = { 
    success: true, 
    reward,
    refRewards: refs.length 
  };
});

// Создание заявки на вывод
router.post("/api/withdraw", async (ctx) => {
  const { userId, wallet, amount } = await ctx.request.body().value;
  
  if (amount < CONFIG.MIN_WITHDRAW) {
    ctx.response.status = 400;
    ctx.response.body = { error: `Minimum is $${CONFIG.MIN_WITHDRAW}` };
    return;
  }

  const user = await kv.get(["users", userId]);
  if (!user.value || user.value.balance < amount) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Insufficient balance" };
    return;
  }

  const withdrawId = crypto.randomUUID();
  await kv.atomic()
    .set(["withdrawals", withdrawId], {
      userId,
      amount,
      wallet,
      status: "pending",
      date: new Date().toISOString()
    })
    .sum(["users", userId, "balance"], -amount)
    .commit();

  ctx.response.body = { success: true, withdrawId };
});

// ========== АДМИН ПАНЕЛЬ ========== //

// Авторизация
router.post("/admin/login", async (ctx) => {
  const { password } = await ctx.request.body().value;
  
  if (password === CONFIG.ADMIN_PASSWORD) {
    const token = crypto.randomUUID();
    await kv.set(["adminTokens", token], { valid: true });
    ctx.response.body = { token };
  } else {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid password" };
  }
});

// Список заявок
router.get("/admin/withdrawals", async (ctx) => {
  const withdrawals = [];
  for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
    withdrawals.push(entry.value);
  }
  ctx.response.body = withdrawals;
});

// Изменение статуса вывода
router.put("/admin/withdrawals/:id", async (ctx) => {
  const { status } = await ctx.request.body().value;
  const id = ctx.params.id;
  
  const withdraw = await kv.get(["withdrawals", id]);
  if (!withdraw.value) {
    ctx.response.status = 404;
    return;
  }

  await kv.set(["withdrawals", id], { ...withdraw.value, status });
  ctx.response.body = { success: true };
});

// Статистика
router.get("/admin/stats", async (ctx) => {
  let totalUsers = 0;
  let totalWithdraws = 0;
  
  for await (const _ of kv.list({ prefix: ["users"] })) totalUsers++;
  for await (const _ of kv.list({ prefix: ["withdrawals"] })) totalWithdraws++;

  ctx.response.body = {
    totalUsers,
    totalWithdraws,
    dailyLimit: CONFIG.DAILY_LIMIT
  };
});

app.use(router.routes());
await app.listen({ port: 8000 });
console.log("Server started on port 8000");
