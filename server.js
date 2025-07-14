import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";
import { create, verify } from "https://deno.land/x/djwt/mod.ts";

const app = new Application();
const router = new Router();
const kv = await Deno.openKv();

// Конфигурация
const CONFIG = {
  REWARD_PER_AD: 0.0003,
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "AdGramAdmin777",
  SECRET_KEY: "your_secret_key_123",
  JWT_SECRET: "your_jwt_secret_456"
};

// Включение CORS
app.use(oakCors({ origin: "*" }));
app.use(router.routes());
app.use(router.allowedMethods());

// Генерация JWT токена
async function generateToken(payload: any): Promise<string> {
  return await create({ alg: "HS256", typ: "JWT" }, payload, CONFIG.JWT_SECRET);
}

// Middleware для проверки JWT
async function authMiddleware(ctx: any, next: any) {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Authorization header missing" };
    return;
  }

  const token = authHeader.split(" ")[1];
  try {
    const payload = await verify(token, CONFIG.JWT_SECRET);
    ctx.state.user = payload;
    await next();
  } catch (err) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid token" };
  }
}

// Регистрация пользователя
router.post("/api/register", async (ctx) => {
  const { refCode } = await ctx.request.body().value;
  const userId = `user_${crypto.randomUUID()}`;
  const referralCode = Math.random().toString(36).substring(2, 10).toUpperCase();

  // Если есть реферальный код, находим реферера
  let referrerId = null;
  if (refCode) {
    for await (const entry of kv.list({ prefix: ["users"] })) {
      if (entry.value?.referralCode === refCode) {
        referrerId = entry.key[1];
        break;
      }
    }
  }

  await kv.set(["users", userId], {
    balance: 0,
    referralCode,
    referrerId,
    refCount: 0,
    refEarnings: 0,
    completedTasks: [],
    createdAt: new Date().toISOString()
  });

  ctx.response.body = { userId, refCode: referralCode };
});

// Получение данных пользователя
router.get("/api/user/:userId", async (ctx) => {
  const user = await kv.get(["users", ctx.params.userId]);
  if (!user.value) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User not found" };
    return;
  }
  ctx.response.body = user.value;
});

// Просмотр рекламы
router.post("/api/watch-ad", async (ctx) => {
  const { userId, adType } = await ctx.request.body().value;
  const today = new Date().toISOString().split("T")[0];
  
  const [user, dailyViews] = await Promise.all([
    kv.get(["users", userId]),
    kv.get(["stats", today, userId])
  ]);

  if (!user.value) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User not found" };
    return;
  }

  if ((dailyViews.value?.views || 0) >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { error: "Daily limit reached" };
    return;
  }

  // Начисляем вознаграждение
  const newBalance = user.value.balance + CONFIG.REWARD_PER_AD;
  
  // Если есть реферер, начисляем ему бонус
  let refUpdate = {};
  if (user.value.referrerId) {
    const referrer = await kv.get(["users", user.value.referrerId]);
    const refEarnings = referrer.value.refEarnings + (CONFIG.REWARD_PER_AD * CONFIG.REFERRAL_PERCENT);
    refUpdate = { refEarnings };
    await kv.set(["users", user.value.referrerId], { ...referrer.value, ...refUpdate });
  }

  await kv.atomic()
    .set(["users", userId], { ...user.value, balance: newBalance })
    .set(["stats", today, userId], { views: (dailyViews.value?.views || 0) + 1 })
    .commit();

  ctx.response.body = {
    success: true,
    balance: newBalance,
    views: (dailyViews.value?.views || 0) + 1
  };
});

// Создание заявки на вывод
router.post("/api/withdraw", async (ctx) => {
  const { userId, wallet, amount } = await ctx.request.body().value;
  
  if (amount < CONFIG.MIN_WITHDRAW) {
    ctx.response.status = 400;
    ctx.response.body = { error: `Minimum withdrawal is $${CONFIG.MIN_WITHDRAW}` };
    return;
  }

  const user = await kv.get(["users", userId]);
  if (!user.value) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User not found" };
    return;
  }

  if (user.value.balance < amount) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Insufficient balance" };
    return;
  }

  // Создаем заявку на вывод
  const withdrawId = `wd_${crypto.randomUUID()}`;
  const newBalance = user.value.balance - amount;

  await kv.atomic()
    .set(["users", userId], { ...user.value, balance: newBalance })
    .set(["withdrawals", withdrawId], {
      userId,
      wallet,
      amount,
      status: "pending",
      date: new Date().toISOString()
    })
    .commit();

  ctx.response.body = {
    success: true,
    withdrawId,
    balance: newBalance
  };
});

// Получение статистики за день
router.get("/api/stats/:userId/:date", async (ctx) => {
  const stats = await kv.get(["stats", ctx.params.date, ctx.params.userId]);
  ctx.response.body = stats.value || { views: 0 };
});

// Управление заданиями
router.get("/api/tasks", async (ctx) => {
  const tasks = [];
  for await (const entry of kv.list({ prefix: ["tasks"] })) {
    tasks.push({
      id: entry.key[1],
      ...entry.value
    });
  }
  ctx.response.body = tasks;
});

// Завершение задания
router.post("/api/user/:userId/complete-task", async (ctx) => {
  const { taskId } = await ctx.request.body().value;
  
  const [user, task] = await Promise.all([
    kv.get(["users", ctx.params.userId]),
    kv.get(["tasks", taskId])
  ]);

  if (!user.value || !task.value) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User or task not found" };
    return;
  }

  if (user.value.completedTasks.includes(taskId)) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Task already completed" };
    return;
  }

  const newBalance = user.value.balance + task.value.reward;
  const completedTasks = [...user.value.completedTasks, taskId];

  await kv.set(["users", ctx.params.userId], {
    ...user.value,
    balance: newBalance,
    completedTasks
  });

  ctx.response.body = {
    success: true,
    balance: newBalance,
    completedTasks
  };
});

// Админ-панель
router.post("/admin/login", async (ctx) => {
  const { password } = await ctx.request.body().value;
  if (password === CONFIG.ADMIN_PASSWORD) {
    const token = await generateToken({ role: "admin" });
    ctx.response.body = { token };
  } else {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid password" };
  }
});

// Получение заявок на вывод
router.get("/admin/withdrawals", authMiddleware, async (ctx) => {
  const { status } = ctx.request.url.searchParams;
  const withdrawals = [];
  
  for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
    if (!status || entry.value.status === status) {
      withdrawals.push({
        id: entry.key[1],
        ...entry.value
      });
    }
  }

  ctx.response.body = withdrawals;
});

// Обновление статуса заявки
router.put("/admin/withdrawals/:id", authMiddleware, async (ctx) => {
  const { status } = await ctx.request.body().value;
  const withdrawal = await kv.get(["withdrawals", ctx.params.id]);

  if (!withdrawal.value) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Withdrawal not found" };
    return;
  }

  await kv.set(["withdrawals", ctx.params.id], {
    ...withdrawal.value,
    status
  });

  ctx.response.body = { success: true };
});

// Добавление задания
router.post("/admin/tasks", authMiddleware, async (ctx) => {
  const { title, reward, description, url, cooldown } = await ctx.request.body().value;
  const taskId = `task_${crypto.randomUUID()}`;

  await kv.set(["tasks", taskId], {
    title,
    reward: parseFloat(reward),
    description,
    url,
    cooldown: parseInt(cooldown) || 10,
    createdAt: new Date().toISOString()
  });

  ctx.response.body = { success: true, taskId };
});

// Удаление задания
router.delete("/admin/tasks/:id", authMiddleware, async (ctx) => {
  await kv.delete(["tasks", ctx.params.id]);
  ctx.response.body = { success: true };
});

// Запуск сервера
console.log("Server running on http://localhost:8000");
await app.listen({ port: 8000 });
