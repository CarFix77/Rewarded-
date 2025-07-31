import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  WEBHOOK_SECRET: "wagner1080",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223",
  TASK_REWARDS: {
    FOLLOW: 0.10,
    LIKE: 0.05,
    RETWEET: 0.07,
    COMMENT: 0.15
  },
  DATA_RETENTION_DAYS: 60
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Функция очистки старых данных
async function cleanupOldData() {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - CONFIG.DATA_RETENTION_DAYS);

    console.log(`[Cleanup] Removing data older than ${cutoffDate.toISOString()}`);

    // Удаление старых пользователей
    let deletedUsers = 0;
    for await (const entry of kv.list({ prefix: ["users"] })) {
      if (new Date(entry.value.createdAt) < cutoffDate && 
          entry.value.balance === 0 && 
          entry.value.refCount === 0) {
        await kv.delete(entry.key);
        deletedUsers++;
      }
    }

    // Удаление старых выводов
    let deletedWithdrawals = 0;
    for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
      if (new Date(entry.value.date) < cutoffDate && 
          ["completed", "rejected"].includes(entry.value.status)) {
        await kv.delete(entry.key);
        deletedWithdrawals++;
      }
    }

    // Удаление старой статистики просмотров
    let deletedViews = 0;
    for await (const entry of kv.list({ prefix: ["views"] })) {
      const dateStr = entry.key[2];
      if (new Date(dateStr) < cutoffDate) {
        await kv.delete(entry.key);
        deletedViews++;
      }
    }

    console.log(`[Cleanup] Deleted: Users=${deletedUsers}, Withdrawals=${deletedWithdrawals}, Views=${deletedViews}`);
  } catch (error) {
    console.error("Cleanup error:", error);
  }
}

// Middleware
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`${ctx.request.method} ${ctx.request.url.pathname} - ${ms}ms`);
});

// Генерация ID
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Регистрация пользователя
router.post("/register", async (ctx) => {
  try {
    const { refCode } = await ctx.request.body().value;
    const userId = `user_${generateId()}`;
    const userRefCode = generateId().toString();
    const now = new Date().toISOString();

    await kv.set(["users", userId], {
      balance: 0,
      refCode: userRefCode,
      refCount: 0,
      refEarnings: 0,
      completedTasks: [],
      createdAt: now,
      lastActive: now
    });

    if (refCode) {
      for await (const entry of kv.list({ prefix: ["users"] })) {
        if (entry.value.refCode === refCode) {
          const bonus = CONFIG.REWARD_PER_AD * CONFIG.REFERRAL_PERCENT;
          await kv.set(entry.key, {
            ...entry.value,
            refCount: entry.value.refCount + 1,
            refEarnings: entry.value.refEarnings + bonus,
            balance: entry.value.balance + bonus,
            lastActive: now
          });
          break;
        }
      }
    }

    ctx.response.body = {
      userId,
      refCode: userRefCode,
      refLink: `${ctx.request.url.origin}?ref=${userRefCode}`
    };
  } catch (error) {
    console.error("Registration error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Получение информации о пользователе
router.get("/user/:userId", async (ctx) => {
  try {
    const userId = ctx.params.userId;
    const user = (await kv.get(["users", userId])).value;
    
    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }
    
    // Обновляем время последней активности
    await kv.set(["users", userId], {
      ...user,
      lastActive: new Date().toISOString()
    });
    
    ctx.response.body = {
      ...user,
      completedTasks: user.completedTasks || []
    };
  } catch (error) {
    console.error("User fetch error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Reward endpoint
router.get("/reward", async (ctx) => {
  try {
    const userId = ctx.request.url.searchParams.get("userid");
    const secret = ctx.request.url.searchParams.get("secret");

    if (secret !== CONFIG.SECRET_KEY && secret !== CONFIG.WEBHOOK_SECRET) {
      ctx.response.status = 401;
      ctx.response.body = { error: "Invalid secret" };
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    const [userRes, viewsRes] = await kv.getMany([["users", userId], ["views", userId, today]]);
    const user = userRes.value || { balance: 0 };
    const dailyViews = viewsRes.value || 0;

    if (dailyViews >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 429;
      ctx.response.body = { error: "Daily limit reached" };
      return;
    }

    const newBalance = user.balance + CONFIG.REWARD_PER_AD;
    const now = new Date().toISOString();

    await kv.atomic()
      .set(["users", userId], { ...user, balance: newBalance, lastActive: now })
      .set(["views", userId, today], dailyViews + 1)
      .commit();

    ctx.response.body = {
      success: true,
      reward: CONFIG.REWARD_PER_AD,
      balance: newBalance,
      viewsToday: dailyViews + 1
    };
  } catch (error) {
    console.error("Reward error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Вывод средств
router.post("/withdraw", async (ctx) => {
  try {
    const { userId, wallet, amount } = await ctx.request.body().value;
    const user = (await kv.get(["users", userId])).value;

    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }

    if (amount < CONFIG.MIN_WITHDRAW || user.balance < amount) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid withdrawal amount" };
      return;
    }

    const withdrawId = `wd_${generateId()}`;
    const now = new Date().toISOString();

    await kv.atomic()
      .set(["users", userId], { ...user, balance: user.balance - amount, lastActive: now })
      .set(["withdrawals", withdrawId], {
        userId,
        amount,
        wallet,
        date: now,
        status: "pending"
      })
      .commit();

    ctx.response.body = { success: true, withdrawId };
  } catch (error) {
    console.error("Withdrawal error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Задания
router.get("/tasks", async (ctx) => {
  try {
    const defaultTasks = [
      {
        id: "follow_twitter",
        title: "Подписаться на Twitter",
        description: "Подпишитесь на наш Twitter аккаунт и получите награду",
        reward: CONFIG.TASK_REWARDS.FOLLOW,
        url: "https://twitter.com",
        cooldown: 10
      },
      {
        id: "like_tweet",
        title: "Лайкнуть твит",
        description: "Поставьте лайк на наш последний твит",
        reward: CONFIG.TASK_REWARDS.LIKE,
        url: "https://twitter.com/tweet",
        cooldown: 10
      },
      {
        id: "retweet",
        title: "Ретвитнуть",
        description: "Сделайте ретвит нашего сообщения",
        reward: CONFIG.TASK_REWARDS.RETWEET,
        url: "https://twitter.com/retweet",
        cooldown: 15
      },
      {
        id: "comment",
        title: "Оставить комментарий",
        description: "Оставьте комментарий под нашим постом",
        reward: CONFIG.TASK_REWARDS.COMMENT,
        url: "https://twitter.com/comment",
        cooldown: 20
      }
    ];

    const customTasks = [];
    for await (const entry of kv.list({ prefix: ["custom_tasks"] })) {
      customTasks.push(entry.value);
    }

    ctx.response.body = [...defaultTasks, ...customTasks];
  } catch (error) {
    console.error("Tasks error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Завершение задания
router.post("/user/:userId/complete-task", async (ctx) => {
  try {
    const userId = ctx.params.userId;
    const { taskId } = await ctx.request.body().value;
    
    const user = (await kv.get(["users", userId])).value;
    
    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }
    
    const completedTasks = user.completedTasks || [];
    if (completedTasks.includes(taskId)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Task already completed" };
      return;
    }
    
    // Получаем задание из кеша
    const task = [...defaultTasks, ...customTasks].find(t => t.id === taskId);
    
    if (!task) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Task not found" };
      return;
    }
    
    const newBalance = user.balance + task.reward;
    const newCompletedTasks = [...completedTasks, taskId];
    const now = new Date().toISOString();
    
    await kv.set(["users", userId], {
      ...user,
      balance: newBalance,
      completedTasks: newCompletedTasks,
      lastActive: now
    });
    
    ctx.response.body = {
      balance: newBalance,
      completedTasks: newCompletedTasks
    };
  } catch (error) {
    console.error("Complete task error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Админ-панель
router.post("/admin/login", async (ctx) => {
  try {
    const { password } = await ctx.request.body().value;
    if (password === CONFIG.ADMIN_PASSWORD) {
      ctx.response.body = { 
        success: true, 
        token: "admin_" + generateId() 
      };
    } else {
      ctx.response.status = 401;
      ctx.response.body = { error: "Wrong password" };
    }
  } catch (error) {
    console.error("Admin login error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

router.get("/admin/withdrawals", async (ctx) => {
  try {
    const withdrawals = [];
    for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
      withdrawals.push(entry.value);
    }
    ctx.response.body = withdrawals;
  } catch (error) {
    console.error("Withdrawals fetch error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

router.post("/admin/withdrawals/:id", async (ctx) => {
  try {
    const { status } = await ctx.request.body().value;
    const withdrawal = (await kv.get(["withdrawals", ctx.params.id])).value;

    if (!withdrawal) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Not found" };
      return;
    }

    await kv.set(["withdrawals", ctx.params.id], {
      ...withdrawal,
      status,
      processedAt: new Date().toISOString()
    });

    ctx.response.body = { success: true };
  } catch (error) {
    console.error("Withdrawal update error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Управление заданиями (админ)
router.get("/admin/tasks", async (ctx) => {
  try {
    const customTasks = [];
    for await (const entry of kv.list({ prefix: ["custom_tasks"] })) {
      customTasks.push(entry.value);
    }
    
    ctx.response.body = customTasks;
  } catch (error) {
    console.error("Admin tasks error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

router.post("/admin/tasks", async (ctx) => {
  try {
    const { title, reward, description, url, cooldown } = await ctx.request.body().value;
    const taskId = `custom_${generateId()}`;
    
    await kv.set(["custom_tasks", taskId], {
      id: taskId,
      title,
      reward: parseFloat(reward),
      description,
      url,
      cooldown: parseInt(cooldown) || 10,
      createdAt: new Date().toISOString()
    });
    
    ctx.response.body = { id: taskId };
  } catch (error) {
    console.error("Task creation error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

router.delete("/admin/tasks/:id", async (ctx) => {
  try {
    await kv.delete(["custom_tasks", ctx.params.id]);
    ctx.response.body = { success: true };
  } catch (error) {
    console.error("Task deletion error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Статус сервера
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "OK",
    version: "1.0",
    endpoints: {
      register: "POST /register",
      reward: "/reward?userid=USERID&secret=wagner46375",
      withdraw: "POST /withdraw",
      admin: "/admin/login",
      tasks: "GET /tasks",
      completeTask: "POST /user/:userId/complete-task"
    }
  };
});

// Обработка ошибок
app.use(async (ctx) => {
  ctx.response.status = 404;
  ctx.response.body = { error: "Not found" };
});

app.addEventListener("error", (evt) => {
  console.error("Server error:", evt.error);
});

// Запуск сервера и очистки
cleanupOldData();
setInterval(cleanupOldData, 24 * 60 * 60 * 1000);

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
