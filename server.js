import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  REWARD_SECRET: "AdRewardsSecure123",
  ADMIN_PASSWORD: "AdGramAdmin777",
  ADMIN_TOKEN: "demo_admin_token"
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Настройка CORS
app.use(oakCors({ origin: "*" }));
app.use(router.routes());
app.use(router.allowedMethods());

// Middleware для проверки админского токена
const adminAuth = async (ctx: any, next: any) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${CONFIG.ADMIN_TOKEN}`) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Unauthorized" };
    return;
  }
  await next();
};

// Регистрация пользователя
router.post("/api/register", async (ctx) => {
  try {
    const { refCode } = await ctx.request.body().value;
    const userId = `user_${crypto.randomUUID()}`;
    const userRefCode = generateReferralCode();
    
    // Если есть реферальный код, находим реферера
    if (refCode) {
      for await (const entry of kv.list({ prefix: ["users"] })) {
        if (entry.value.refCode === refCode) {
          await kv.atomic()
            .set(["users", userId], { 
              balance: 0, 
              refCode: userRefCode,
              refBy: refCode
            })
            .sum(["users", entry.key[1], "refCount"], 1)
            .commit();
          
          ctx.response.body = { userId, refCode: userRefCode };
          return;
        }
      }
    }
    
    // Если реферального кода нет или он не найден
    await kv.set(["users", userId], { 
      balance: 0, 
      refCode: userRefCode,
      refCount: 0,
      refEarnings: 0
    });
    
    ctx.response.body = { userId, refCode: userRefCode };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Registration failed" };
  }
});

// Получение данных пользователя
router.get("/api/user/:userId", async (ctx) => {
  const userId = ctx.params.userId;
  if (!userId) {
    ctx.response.status = 400;
    ctx.response.body = { error: "User ID is required" };
    return;
  }

  try {
    const user = await kv.get(["users", userId]);
    if (!user.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }
    
    ctx.response.body = user.value;
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to get user data" };
  }
});

// Статистика просмотров
router.get("/api/stats/:userId/:date", async (ctx) => {
  const { userId, date } = ctx.params;
  if (!userId || !date) {
    ctx.response.status = 400;
    ctx.response.body = { error: "User ID and date are required" };
    return;
  }

  try {
    const stats = await kv.get(["stats", userId, date]);
    ctx.response.body = stats.value || { views: 0 };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to get stats" };
  }
});

// Просмотр рекламы
router.post("/api/watch-ad", async (ctx) => {
  try {
    const { userId, adType } = await ctx.request.body().value;
    if (!userId || !adType) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid parameters" };
      return;
    }

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

    // Проверка лимитов
    const viewsToday = dailyViews.value?.views || 0;
    if (viewsToday >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 429;
      ctx.response.body = { error: "Daily limit reached" };
      return;
    }

    // Начисление
    const reward = CONFIG.REWARD_PER_AD;
    let operations = kv.atomic()
      .sum(["users", userId, "balance"], reward)
      .set(["stats", userId, today], { views: viewsToday + 1 });

    // Если есть реферер, начисляем ему процент
    if (user.value.refBy) {
      const refReward = reward * CONFIG.REFERRAL_PERCENT;
      operations = operations
        .sum(["users", user.value.refBy, "refEarnings"], refReward)
        .sum(["users", user.value.refBy, "balance"], refReward);
    }

    await operations.commit();

    ctx.response.body = {
      success: true,
      reward,
      viewsToday: viewsToday + 1
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Ad processing failed" };
  }
});

// Создание заявки на вывод
router.post("/api/withdraw", async (ctx) => {
  try {
    const { userId, wallet, amount } = await ctx.request.body().value;
    if (!userId || !wallet || !amount) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid parameters" };
      return;
    }

    // Валидация суммы
    if (amount < CONFIG.MIN_WITHDRAW) {
      ctx.response.status = 400;
      ctx.response.body = { error: `Minimum withdrawal is $${CONFIG.MIN_WITHDRAW}` };
      return;
    }

    // Проверка баланса
    const user = await kv.get(["users", userId]);
    if (!user.value || user.value.balance < amount) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Insufficient balance" };
      return;
    }

    // Создание заявки
    const withdrawId = `wd_${Date.now()}`;
    await kv.atomic()
      .set(["withdrawals", withdrawId], {
        userId,
        wallet,
        amount,
        status: "pending",
        date: new Date().toISOString()
      })
      .sum(["users", userId, "balance"], -amount)
      .commit();

    ctx.response.body = { 
      success: true,
      withdrawId
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Withdrawal processing failed" };
  }
});

// Управление заданиями
router.get("/api/tasks", async (ctx) => {
  try {
    const tasks = [];
    for await (const entry of kv.list({ prefix: ["tasks"] })) {
      tasks.push(entry.value);
    }
    ctx.response.body = tasks;
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to get tasks" };
  }
});

// Завершение задания
router.post("/api/user/:userId/complete-task", adminAuth, async (ctx) => {
  try {
    const userId = ctx.params.userId;
    const { taskId } = await ctx.request.body().value;
    
    if (!userId || !taskId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid parameters" };
      return;
    }

    // Получаем задание
    const task = await kv.get(["tasks", taskId]);
    if (!task.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Task not found" };
      return;
    }

    // Получаем пользователя
    const user = await kv.get(["users", userId]);
    if (!user.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }

    // Проверяем, не выполнял ли уже пользователь это задание
    const completedTasks = user.value.completedTasks || [];
    if (completedTasks.includes(taskId)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Task already completed" };
      return;
    }

    // Начисляем награду
    const reward = task.value.reward;
    await kv.atomic()
      .sum(["users", userId, "balance"], reward)
      .set(["users", userId, "completedTasks"], [...completedTasks, taskId])
      .commit();

    ctx.response.body = { 
      success: true,
      balance: (user.value.balance || 0) + reward,
      completedTasks: [...completedTasks, taskId]
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Task completion failed" };
  }
});

// Админские эндпоинты
router.get("/admin/withdrawals", adminAuth, async (ctx) => {
  try {
    const status = ctx.request.url.searchParams.get("status") || "pending";
    const withdrawals = [];
    
    for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
      if (entry.value.status === status) {
        withdrawals.push({
          id: entry.key[1],
          ...entry.value
        });
      }
    }
    
    ctx.response.body = withdrawals;
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to get withdrawals" };
  }
});

router.put("/admin/withdrawals/:id", adminAuth, async (ctx) => {
  try {
    const id = ctx.params.id;
    const { status } = await ctx.request.body().value;
    
    if (!id || !["pending", "completed", "rejected"].includes(status)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid parameters" };
      return;
    }

    const withdrawal = await kv.get(["withdrawals", id]);
    if (!withdrawal.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Withdrawal not found" };
      return;
    }

    await kv.set(["withdrawals", id], {
      ...withdrawal.value,
      status
    });

    ctx.response.body = { success: true };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to update withdrawal" };
  }
});

// Главный эндпоинт
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "OK",
    app: "AdRewards+",
    endpoints: {
      register: "/api/register",
      user: "/api/user/:userId",
      watch_ad: "/api/watch-ad",
      withdraw: "/api/withdraw",
      tasks: "/api/tasks"
    }
  };
});

// Вспомогательные функции
function generateReferralCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Запуск сервера
const port = 8000;
console.log(`Server running on port ${port}`);
await app.listen({ port });
