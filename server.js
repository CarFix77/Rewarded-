import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

// Инициализация хранилища и приложения
const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Конфигурация
const CONFIG = {
  REWARD_PER_AD: 0.0003,
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "AdGramAdmin777",
  SECRET_KEY: "Jora1514"
};

// Включение CORS
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

// Middleware для логирования
app.use(async (ctx, next) => {
  console.log(`[${new Date().toISOString()}] ${ctx.request.method} ${ctx.request.url}`);
  await next();
});

// Проверка работоспособности сервера
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "OK",
    app: "AdRewards+",
    version: "1.0.0",
    endpoints: {
      register: "/api/register",
      watchAd: "/api/watch-ad",
      withdraw: "/api/withdraw",
      tasks: "/api/tasks"
    }
  };
});

// Регистрация пользователя
router.post("/api/register", async (ctx) => {
  try {
    const { refCode } = await ctx.request.body().value;
    const userId = `user_${crypto.randomUUID()}`;
    const userRefCode = Math.random().toString(36).substring(2, 10).toUpperCase();

    await kv.set(["users", userId], {
      balance: 0,
      adViews: 0,
      refCode: userRefCode,
      refCount: 0,
      refEarnings: 0,
      createdAt: new Date().toISOString()
    });

    if (refCode) {
      for await (const entry of kv.list({ prefix: ["users"] })) {
        if (entry.value.refCode === refCode) {
          await kv.set(["refs", refCode, userId], { date: new Date().toISOString() });
          await kv.set(["users", entry.key[1], "refCount"], entry.value.refCount + 1);
          break;
        }
      }
    }

    ctx.response.body = {
      success: true,
      userId,
      refCode: userRefCode
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Registration failed" };
  }
});

// Просмотр рекламы
router.post("/api/watch-ad", async (ctx) => {
  try {
    const { userId } = await ctx.request.body().value;
    const today = new Date().toISOString().split("T")[0];
    
    const [user, dailyViews] = await Promise.all([
      kv.get(["users", userId]),
      kv.get(["stats", userId, today])
    ]);

    if (!user.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }

    const viewsToday = dailyViews.value?.views || 0;
    if (viewsToday >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Daily limit reached" };
      return;
    }

    const reward = CONFIG.REWARD_PER_AD;
    let refRewards = 0;

    // Начисление реферальных бонусов
    for await (const entry of kv.list({ prefix: ["refs", userId] })) {
      const refUserId = entry.key[2];
      const refReward = reward * CONFIG.REFERRAL_PERCENT;
      await kv.atomic()
        .sum(["users", refUserId, "balance"], refReward)
        .sum(["users", refUserId, "refEarnings"], refReward)
        .commit();
      refRewards++;
    }

    // Обновление баланса и статистики
    const newBalance = (user.value.balance || 0) + reward;
    await kv.atomic()
      .set(["users", userId, "balance"], newBalance)
      .set(["stats", userId, today], { views: viewsToday + 1 })
      .set(["users", userId, "adViews"], (user.value.adViews || 0) + 1)
      .commit();

    ctx.response.body = {
      success: true,
      reward,
      refRewards,
      balance: newBalance,
      viewsToday: viewsToday + 1
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to process ad view" };
  }
});

// Вывод средств
router.post("/api/withdraw", async (ctx) => {
  try {
    const { userId, wallet, amount } = await ctx.request.body().value;
    
    if (amount < CONFIG.MIN_WITHDRAW) {
      ctx.response.status = 400;
      ctx.response.body = { error: `Minimum withdrawal is $${CONFIG.MIN_WITHDRAW}` };
      return;
    }

    if (!/^P\d{7,}$/.test(wallet)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid PAYEER wallet format" };
      return;
    }

    const user = await kv.get(["users", userId]);
    if (!user.value || user.value.balance < amount) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Insufficient balance" };
      return;
    }

    const withdrawId = crypto.randomUUID();
    const newBalance = user.value.balance - amount;
    
    await kv.atomic()
      .set(["withdrawals", withdrawId], {
        userId,
        amount,
        wallet,
        status: "pending",
        date: new Date().toISOString(),
        adViews: user.value.adViews || 0
      })
      .set(["users", userId, "balance"], newBalance)
      .commit();

    ctx.response.body = {
      success: true,
      withdrawId,
      balance: newBalance
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Withdrawal failed" };
  }
});

// Получение заданий
router.get("/api/tasks", (ctx) => {
  ctx.response.body = {
    success: true,
    tasks: [
      {
        id: "follow_telegram",
        title: "Подпишитесь на Telegram",
        description: "Подпишитесь на наш канал в Telegram",
        reward: 0.10,
        url: "https://t.me/your_channel",
        cooldown: 60
      },
      {
        id: "join_chat",
        title: "Вступите в чат",
        description: "Присоединитесь к нашему Telegram чату",
        reward: 0.15,
        url: "https://t.me/your_chat",
        cooldown: 90
      }
    ]
  };
});

// Обработка ошибок
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
    console.error(err);
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

const port = parseInt(Deno.env.get("PORT") || 8000);
console.log(`Server running on port ${port}`);
await app.listen({ port });
