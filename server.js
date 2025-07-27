import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

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
  }
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Настройка CORS
app.use(oakCors({ origin: "*" }));
app.use(router.routes());
app.use(router.allowedMethods());

// Генерация ID
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Получение информации о пользователе
router.get("/user/:userId", async (ctx) => {
  const userId = ctx.params.userId;
  const user = (await kv.get(["users", userId])).value;
  
  if (!user) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User not found" };
    return;
  }
  
  // Добавляем completedTasks если их нет
  const userWithTasks = {
    ...user,
    completedTasks: user.completedTasks || []
  };
  
  ctx.response.body = userWithTasks;
});

// Получение статистики просмотров
router.get("/views/:userId/:date", async (ctx) => {
  const { userId, date } = ctx.params;
  const views = (await kv.get(["views", userId, date])).value || 0;
  ctx.response.body = views;
});

// Регистрация пользователя
router.post("/register", async (ctx) => {
  const { refCode, telegramId } = await ctx.request.body().value;
  const userId = `user_${generateId()}`;
  const userRefCode = generateId().toString();

  await kv.set(["users", userId], {
    balance: 0,
    telegramId: telegramId || null,
    refCode: userRefCode,
    refCount: 0,
    refEarnings: 0,
    completedTasks: [],
    createdAt: new Date().toISOString()
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
          balance: entry.value.balance + bonus
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
});

// Reward Webhook
router.get("/reward", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  const secret = ctx.request.url.searchParams.get("secret");

  // Проверка секрета
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
  await kv.atomic()
    .set(["users", userId], { ...user, balance: newBalance })
    .set(["views", userId, today], dailyViews + 1)
    .commit();

  ctx.response.body = {
    success: true,
    reward: CONFIG.REWARD_PER_AD,
    balance: newBalance,
    viewsToday: dailyViews + 1
  };
});

// Вывод средств
router.post("/withdraw", async (ctx) => {
  const { userId, wallet, amount } = await ctx.request.body().value;
  const user = (await kv.get(["users", userId])).value;

  if (!user || amount < CONFIG.MIN_WITHDRAW || user.balance < amount) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Invalid withdrawal" };
    return;
  }

  const withdrawId = `wd_${generateId()}`;
  await kv.atomic()
    .set(["users", userId], { ...user, balance: user.balance - amount })
    .set(["withdrawals", withdrawId], {
      userId,
      amount,
      wallet,
      date: new Date().toISOString(),
      status: "pending"
    })
    .commit();

  ctx.response.body = { success: true, withdrawId };
});

// Задания
router.get("/tasks", async (ctx) => {
  // Стандартные задания
  const tasks = [
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

  ctx.response.body = tasks;
});

// Завершение задания
router.post("/user/:userId/complete-task", async (ctx) => {
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
  const tasks = [
    { id: "follow_twitter", reward: CONFIG.TASK_REWARDS.FOLLOW },
    { id: "like_tweet", reward: CONFIG.TASK_REWARDS.LIKE },
    { id: "retweet", reward: CONFIG.TASK_REWARDS.RETWEET },
    { id: "comment", reward: CONFIG.TASK_REWARDS.COMMENT }
  ];
  
  const task = tasks.find(t => t.id === taskId);
  if (!task) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Task not found" };
    return;
  }
  
  const newBalance = user.balance + task.reward;
  const newCompletedTasks = [...completedTasks, taskId];
  
  await kv.set(["users", userId], {
    ...user,
    balance: newBalance,
    completedTasks: newCompletedTasks
  });
  
  ctx.response.body = {
    balance: newBalance,
    completedTasks: newCompletedTasks
  };
});

// Админ-панель
router.post("/admin/login", async (ctx) => {
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
});

router.get("/admin/withdrawals", async (ctx) => {
  const withdrawals = [];
  for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
    withdrawals.push(entry.value);
  }
  ctx.response.body = withdrawals;
});

router.post("/admin/withdrawals/:id", async (ctx) => {
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
});

// Управление заданиями (админ)
router.get("/admin/tasks", async (ctx) => {
  // Возвращаем стандартные задания + кастомные из KV
  const customTasks = [];
  for await (const entry of kv.list({ prefix: ["custom_tasks"] })) {
    customTasks.push(entry.value);
  }
  
  const tasks = [
    {
      id: "follow_twitter",
      title: "Подписаться на Twitter",
      reward: CONFIG.TASK_REWARDS.FOLLOW,
      cooldown: 10
    },
    {
      id: "like_tweet",
      title: "Лайкнуть твит",
      reward: CONFIG.TASK_REWARDS.LIKE,
      cooldown: 10
    },
    {
      id: "retweet",
      title: "Ретвитнуть",
      reward: CONFIG.TASK_REWARDS.RETWEET,
      cooldown: 15
    },
    {
      id: "comment",
      title: "Оставить комментарий",
      reward: CONFIG.TASK_REWARDS.COMMENT,
      cooldown: 20
    },
    ...customTasks
  ];
  
  ctx.response.body = tasks;
});

router.post("/admin/tasks", async (ctx) => {
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
});

router.delete("/admin/tasks/:id", async (ctx) => {
  await kv.delete(["custom_tasks", ctx.params.id]);
  ctx.response.body = { success: true };
});

// Статус сервера
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "OK",
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

// Запуск сервера
await app.listen({ port: 8000 });
console.log("Server running on https://carfix77-rewarded-34-46pqhwvzmzmw.deno.dev/");
