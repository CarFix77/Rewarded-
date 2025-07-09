// Импорты
import { Application, Router } from "https://deno.land/x/oak/mod.ts";

// Конфигурация
const CONFIG = {
  SECRET_KEY: "Jora1513", // Ваш API-ключ
  REWARD_AMOUNT: 0.0003, // $ за просмотр
  REF_PERCENT: 0.15, // 15% реферальных
  MIN_WITHDRAW: 1.00, // Минимальный вывод
  ADMIN_PASSWORD: "AdGramAdmin777" // Пароль админки
};

// Инициализация KV-базы (работает в Deno Deploy)
const kv = await Deno.openKv();

// Сервер
const app = new Application();
const router = new Router();

// Middleware для JSON-ответов
app.use(async (ctx, next) => {
  ctx.response.headers.set("Content-Type", "application/json");
  await next();
});

// Проверка API-ключа
router.use(async (ctx, next) => {
  const skipAuth = ["/", "/health"].includes(ctx.request.url.pathname);
  if (skipAuth) return await next();
  
  const key = ctx.request.url.searchParams.get("key");
  if (key !== CONFIG.SECRET_KEY && !ctx.request.url.pathname.startsWith("/admin")) {
    ctx.response.status = 403;
    ctx.response.body = { error: "Invalid API key" };
    return;
  }
  await next();
});

// Health check
router.get("/health", (ctx) => {
  ctx.response.body = { status: "OK" };
});

// Главная страница
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

// Reward URL для AdGram
router.get("/reward", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  if (!userId) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Missing userid" };
    return;
  }

  // Атомарное обновление баланса
  const userKey = ["users", userId];
  const result = await kv.atomic()
    .mutate({
      key: userKey,
      type: "sum",
      value: { balance: CONFIG.REWARD_AMOUNT }
    })
    .commit();

  if (!result.ok) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to update balance" };
    return;
  }

  // Реферальное начисление
  const refId = ctx.request.url.searchParams.get("ref");
  if (refId && refId !== userId) {
    const refReward = CONFIG.REWARD_AMOUNT * CONFIG.REF_PERCENT;
    await kv.atomic()
      .mutate({
        key: ["users", refId],
        type: "sum",
        value: { 
          balance: refReward,
          ref_earnings: refReward,
          referrals: 1
        }
      })
      .commit();
  }

  // Ответ
  const user = await kv.get(userKey);
  ctx.response.body = {
    success: true,
    balance: user.value?.balance || 0
  };
});

// Проверка баланса
router.get("/balance", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  if (!userId) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Missing userid" };
    return;
  }

  const user = await kv.get(["users", userId]);
  ctx.response.body = {
    success: true,
    balance: user.value?.balance || 0,
    referrals: user.value?.referrals || 0,
    ref_earnings: user.value?.ref_earnings || 0
  };
});

// Вывод средств
router.post("/withdraw", async (ctx) => {
  try {
    const { userId, amount, wallet } = await ctx.request.body().value;

    if (!userId || !amount || !wallet) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing data" };
      return;
    }

    if (amount < CONFIG.MIN_WITHDRAW) {
      ctx.response.status = 400;
      ctx.response.body = { error: `Minimum withdraw is $${CONFIG.MIN_WITHDRAW}` };
      return;
    }

    const withdrawalId = crypto.randomUUID();
    const userKey = ["users", userId];

    // Атомарная проверка и списание
    const result = await kv.atomic()
      .check(await kv.get(userKey))
      .mutate({
        key: userKey,
        type: "checkAndSet",
        value: { balance: -amount },
        threshold: amount
      })
      .set(["withdrawals", withdrawalId], {
        userId,
        amount,
        wallet,
        status: "pending",
        createdAt: new Date().toISOString()
      })
      .commit();

    if (!result.ok) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Insufficient balance" };
      return;
    }

    ctx.response.body = { success: true, withdrawalId };

  } catch (e) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Админ-панель
router.get("/admin", async (ctx) => {
  if (ctx.request.url.searchParams.get("password") !== CONFIG.ADMIN_PASSWORD) {
    ctx.response.status = 403;
    ctx.response.body = { error: "Access denied" };
    return;
  }

  const [users, withdrawals] = await Promise.all([
    Array.fromAsync(kv.list({ prefix: ["users"] })),
    Array.fromAsync(kv.list({ prefix: ["withdrawals"] }, { limit: 20, reverse: true }))
  ]);

  const stats = {
    totalUsers: users.length,
    totalBalance: users.reduce((sum, user) => sum + (user.value.balance || 0), 0),
    pendingWithdrawals: withdrawals.filter(w => w.value.status === "pending").length
  };

  ctx.response.body = {
    ...stats,
    recentWithdrawals: withdrawals.map(w => ({
      id: w.key[1],
      userId: w.value.userId,
      amount: w.value.amount,
      status: w.value.status,
      date: w.value.createdAt
    }))
  };
});

// Подключение роутера
app.use(router.routes());
app.use(router.allowedMethods());

// Запуск сервера
console.log("Server started on http://localhost:8000");
await app.listen({ port: 8000 });
