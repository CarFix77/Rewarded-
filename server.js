import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { cron } from "https://deno.land/x/deno_cron@v1.0.0/cron.ts";

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
  // Настройки очистки данных
  CLEANUP: {
    VIEWS_DAYS_TO_KEEP: 30, // Хранить статистику просмотров 30 дней
    COMPLETED_TASKS_DAYS_TO_KEEP: 90, // Хранить историю выполненных заданий 90 дней
    INACTIVE_USERS_DAYS: 365 // Удалять неактивных пользователей через год
  }
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Настройка CORS
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Логирование запросов
app.use(async (ctx, next) => {
  console.log(`${ctx.request.method} ${ctx.request.url.pathname}`);
  await next();
});

// Генерация ID
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Функция очистки старых данных
async function cleanupOldData() {
  console.log("Starting data cleanup...");
  
  try {
    // Очистка старых просмотров
    const viewsCutoffDate = new Date();
    viewsCutoffDate.setDate(viewsCutoffDate.getDate() - CONFIG.CLEANUP.VIEWS_DAYS_TO_KEEP);
    
    let deletedViews = 0;
    for await (const entry of kv.list({ prefix: ["views"] })) {
      const dateString = entry.key[2];
      const entryDate = new Date(dateString);
      
      if (entryDate < viewsCutoffDate) {
        await kv.delete(entry.key);
        deletedViews++;
      }
    }
    console.log(`Deleted ${deletedViews} old view records`);
    
    // Очистка выполненных заданий у неактивных пользователей
    const tasksCutoffDate = new Date();
    tasksCutoffDate.setDate(tasksCutoffDate.getDate() - CONFIG.CLEANUP.COMPLETED_TASKS_DAYS_TO_KEEP);
    
    let updatedUsers = 0;
    for await (const entry of kv.list({ prefix: ["users"] })) {
      if (entry.value.completedTasks && entry.value.completedTasks.length > 0) {
        const lastActiveDate = new Date(entry.value.lastActive || entry.value.createdAt);
        
        if (lastActiveDate < tasksCutoffDate) {
          await kv.set(entry.key, {
            ...entry.value,
            completedTasks: []
          });
          updatedUsers++;
        }
      }
    }
    console.log(`Cleared completed tasks for ${updatedUsers} inactive users`);
    
    // Удаление неактивных пользователей
    const usersCutoffDate = new Date();
    usersCutoffDate.setDate(usersCutoffDate.getDate() - CONFIG.CLEANUP.INACTIVE_USERS_DAYS);
    
    let deletedUsers = 0;
    for await (const entry of kv.list({ prefix: ["users"] })) {
      const lastActiveDate = new Date(entry.value.lastActive || entry.value.createdAt);
      
      if (lastActiveDate < usersCutoffDate) {
        // Удаляем пользователя и связанные данные
        await kv.atomic()
          .delete(entry.key)
          .delete(["views", entry.key[1]])
          .commit();
        deletedUsers++;
      }
    }
    console.log(`Deleted ${deletedUsers} inactive users`);
    
  } catch (error) {
    console.error("Error during data cleanup:", error);
  }
}

// Запускаем очистку каждые 24 часа
cron("0 0 * * *", cleanupOldData);

// Запускаем очистку сразу при старте сервера
cleanupOldData().catch(console.error);

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

    // Реферальный бонус
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
    console.error("Error:", error);
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
    const now = new Date().toISOString();
    await kv.set(["users", userId], {
      ...user,
      lastActive: now
    });
    
    ctx.response.body = {
      ...user,
      completedTasks: user.completedTasks || []
    };
  } catch (error) {
    console.error("Error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Получение статистики просмотров
router.get("/views/:userId/:date", async (ctx) => {
  try {
    const { userId, date } = ctx.params;
    const views = (await kv.get(["views", userId, date])).value || 0;
    ctx.response.body = views;
  } catch (error) {
    console.error("Error:", error);
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
    const user = (await kv.get(["users", userId])).value || { balance: 0 };
    const dailyViews = (await kv.get(["views", userId, today])).value || 0;

    if (dailyViews >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 429;
      ctx.response.body = { error: "Daily limit reached" };
      return;
    }

    const newBalance = user.balance + CONFIG.REWARD_PER_AD;
    const now = new Date().toISOString();
    
    await kv.atomic()
      .set(["users", userId], { 
        ...user, 
        balance: newBalance,
        lastActive: now
      })
      .set(["views", userId, today], dailyViews + 1)
      .commit();

    ctx.response.body = {
      success: true,
      reward: CONFIG.REWARD_PER_AD,
      balance: newBalance,
      viewsToday: dailyViews + 1
    };
  } catch (error) {
    console.error("Error:", error);
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
      .set(["users", userId], { 
        ...user, 
        balance: user.balance - amount,
        lastActive: now
      })
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
    console.error("Error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Задания
router.get("/tasks", async (ctx) => {
  try {
    // Стандартные задания
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

    // Кастомные задания из KV
    const customTasks = [];
    for await (const entry of kv.list({ prefix: ["custom_tasks"] })) {
      customTasks.push(entry.value);
    }

    ctx.response.body = [...defaultTasks, ...customTasks];
  } catch (error) {
    console.error("Error:", error);
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
    
    // Находим задание
    const tasksResponse = await fetch(`${ctx.request.url.origin}/tasks`);
    const tasks = await tasksResponse.json();
    const task = tasks.find(t => t.id === taskId);
    
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
    console.error("Error:", error);
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
    console.error("Error:", error);
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
    console.error("Error:", error);
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
    console.error("Error:", error);
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
    console.error("Error:", error);
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
    console.error("Error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

router.delete("/admin/tasks/:id", async (ctx) => {
  try {
    await kv.delete(["custom_tasks", ctx.params.id]);
    ctx.response.body = { success: true };
  } catch (error) {
    console.error("Error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Ручная очистка данных (админ)
router.post("/admin/cleanup", async (ctx) => {
  try {
    await cleanupOldData();
    ctx.response.body = { success: true, message: "Data cleanup completed" };
  } catch (error) {
    console.error("Error:", error);
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

// Запуск сервера
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
