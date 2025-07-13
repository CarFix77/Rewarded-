import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";
import { create, verify } from "https://deno.land/x/djwt@v2.8/mod.ts";

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
  SECRET_KEY: "Jora1514",
  TASK_REWARDS: {
    FOLLOW_TELEGRAM: 0.10,
    JOIN_CHAT: 0.15,
    WATCH_VIDEO: 0.05
  }
};

// Включение CORS
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Middleware для логирования
app.use(async (ctx, next) => {
  await next();
  const rt = ctx.response.headers.get("X-Response-Time");
  console.log(`${ctx.request.method} ${ctx.request.url} - ${rt}`);
});

// Middleware для измерения времени
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  ctx.response.headers.set("X-Response-Time", `${ms}ms`);
});

// Генерация реферального кода
function generateRefCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

// Middleware для проверки JWT администратора
const adminAuth = async (ctx: any, next: any) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Требуется авторизация" };
    return;
  }

  const token = authHeader.split(" ")[1];
  try {
    await verify(token, CONFIG.SECRET_KEY, "HS256");
    await next();
  } catch (err) {
    ctx.response.status = 403;
    ctx.response.body = { error: "Неверный или просроченный токен" };
  }
};

// Регистрация пользователя
router.post("/api/register", async (ctx) => {
  try {
    const { refCode } = await ctx.request.body().value;
    const userId = "user_" + crypto.randomUUID();
    const userRefCode = generateRefCode();

    await kv.set(["users", userId], {
      balance: 0,
      adViews: 0,
      refCode: userRefCode,
      refCount: 0,
      refEarnings: 0,
      completedTasks: [],
      createdAt: new Date().toISOString()
    });

    if (refCode) {
      for await (const entry of kv.list({ prefix: ["users"] })) {
        if (entry.value.refCode === refCode) {
          await kv.set(["refs", refCode, userId], { 
            date: new Date().toISOString() 
          });
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
    ctx.response.body = { error: "Ошибка регистрации" };
  }
});

// Просмотр рекламы
router.post("/api/watch-ad", async (ctx) => {
  try {
    const { userId } = await ctx.request.body().value;
    const today = new Date().toISOString().split("T")[0];
    
    const user = await kv.get(["users", userId]);
    if (!user.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Пользователь не найден" };
      return;
    }

    const dailyViews = await kv.get(["stats", userId, today]);
    const viewsToday = dailyViews.value?.views || 0;

    if (viewsToday >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Достигнут дневной лимит просмотров" };
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

    // Обновление статистики
    await kv.atomic()
      .sum(["users", userId, "balance"], reward)
      .set(["stats", userId, today], { views: viewsToday + 1 })
      .set(["users", userId, "adViews"], (user.value.adViews || 0) + 1)
      .commit();

    ctx.response.body = { 
      success: true, 
      reward,
      refRewards,
      viewsToday: viewsToday + 1,
      balance: (user.value.balance || 0) + reward
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Ошибка при просмотре рекламы" };
  }
});

// Вывод средств
router.post("/api/withdraw", async (ctx) => {
  try {
    const { userId, wallet, amount } = await ctx.request.body().value;
    
    if (amount < CONFIG.MIN_WITHDRAW) {
      ctx.response.status = 400;
      ctx.response.body = { error: `Минимальная сумма вывода: $${CONFIG.MIN_WITHDRAW}` };
      return;
    }

    const user = await kv.get(["users", userId]);
    if (!user.value || user.value.balance < amount) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Недостаточно средств" };
      return;
    }

    if (!/^P\d{7,}$/.test(wallet)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Неверный формат PAYEER кошелька" };
      return;
    }

    const withdrawId = crypto.randomUUID();
    await kv.atomic()
      .set(["withdrawals", withdrawId], {
        userId,
        amount,
        wallet,
        status: "pending",
        date: new Date().toISOString(),
        adViews: user.value.adViews || 0
      })
      .sum(["users", userId, "balance"], -amount)
      .commit();

    ctx.response.body = { 
      success: true,
      withdrawId,
      balance: user.value.balance - amount
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Ошибка при создании заявки" };
  }
});

// Получение заданий
router.get("/api/tasks", async (ctx) => {
  try {
    const tasks = [
      {
        id: "follow_telegram",
        title: "Подпишитесь на наш Telegram",
        description: "Подпишитесь на наш канал в Telegram и получите вознаграждение",
        reward: CONFIG.TASK_REWARDS.FOLLOW_TELEGRAM,
        url: "https://t.me/your_channel",
        cooldown: 60
      },
      {
        id: "join_chat",
        title: "Вступите в чат",
        description: "Присоединитесь к нашему чату в Telegram",
        reward: CONFIG.TASK_REWARDS.JOIN_CHAT,
        url: "https://t.me/your_chat",
        cooldown: 90
      },
      {
        id: "watch_video",
        title: "Посмотрите видео",
        description: "Посмотрите наше видео до конца",
        reward: CONFIG.TASK_REWARDS.WATCH_VIDEO,
        url: "https://youtube.com/your_video",
        cooldown: 120
      }
    ];

    ctx.response.body = tasks;
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Ошибка загрузки заданий" };
  }
});

// Завершение задания
router.post("/api/complete-task", async (ctx) => {
  try {
    const { userId, taskId } = await ctx.request.body().value;
    
    const user = await kv.get(["users", userId]);
    if (!user.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Пользователь не найден" };
      return;
    }

    if (user.value.completedTasks?.includes(taskId)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Задание уже выполнено" };
      return;
    }

    const task = [
      {
        id: "follow_telegram",
        reward: CONFIG.TASK_REWARDS.FOLLOW_TELEGRAM
      },
      {
        id: "join_chat",
        reward: CONFIG.TASK_REWARDS.JOIN_CHAT
      },
      {
        id: "watch_video",
        reward: CONFIG.TASK_REWARDS.WATCH_VIDEO
      }
    ].find(t => t.id === taskId);

    if (!task) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Задание не найдено" };
      return;
    }

    await kv.atomic()
      .sum(["users", userId, "balance"], task.reward)
      .set(["users", userId, "completedTasks"], [...(user.value.completedTasks || []), taskId])
      .commit();

    ctx.response.body = { 
      success: true,
      reward: task.reward,
      balance: (user.value.balance || 0) + task.reward
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Ошибка выполнения задания" };
  }
});

// Админ-авторизация
router.post("/admin/login", async (ctx) => {
  try {
    const { password } = await ctx.request.body().value;
    
    if (password === CONFIG.ADMIN_PASSWORD) {
      const token = await create(
        { alg: "HS256", typ: "JWT" },
        { 
          admin: true, 
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 // 24 часа
        },
        CONFIG.SECRET_KEY
      );

      ctx.response.body = { 
        success: true,
        token 
      };
    } else {
      ctx.response.status = 401;
      ctx.response.body = { error: "Неверный пароль" };
    }
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Ошибка авторизации" };
  }
});

// Получение заявок на вывод (админ)
router.get("/admin/withdrawals", adminAuth, async (ctx) => {
  try {
    const { status } = ctx.request.url.searchParams;
    const withdrawals = [];
    
    for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
      if (!status || entry.value.status === status) {
        withdrawals.push(entry.value);
      }
    }

    ctx.response.body = {
      success: true,
      withdrawals
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Ошибка загрузки заявок" };
  }
});

// Обновление статуса вывода (админ)
router.put("/admin/withdrawals/:id", adminAuth, async (ctx) => {
  try {
    const { status } = await ctx.request.body().value;
    const id = ctx.params.id;
    
    const withdraw = await kv.get(["withdrawals", id]);
    if (!withdraw.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Заявка не найдена" };
      return;
    }

    await kv.set(["withdrawals", id], { 
      ...withdraw.value, 
      status 
    });

    ctx.response.body = { 
      success: true,
      withdrawal: {
        ...withdraw.value,
        status
      }
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Ошибка обновления заявки" };
  }
});

// Получение статистики (админ)
router.get("/admin/stats", adminAuth, async (ctx) => {
  try {
    let totalUsers = 0;
    let totalWithdraws = 0;
    let totalEarned = 0;
    
    for await (const _ of kv.list({ prefix: ["users"] })) totalUsers++;
    for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
      totalWithdraws++;
      if (entry.value.status === "completed") {
        totalEarned += entry.value.amount;
      }
    }

    ctx.response.body = {
      success: true,
      stats: {
        totalUsers,
        totalWithdraws,
        totalEarned,
        dailyLimit: CONFIG.DAILY_LIMIT
      }
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Ошибка загрузки статистики" };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

// Запуск сервера
const port = parseInt(Deno.env.get("PORT") || 8000;
console.log(`Сервер AdRewards+ запущен на порту ${port}`);
await app.listen({ port });
