import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  WEBHOOK_SECRET: "wagner1080",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223"
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Настройка CORS (должен быть первым middleware)
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Обработка OPTIONS запросов
app.use(async (ctx, next) => {
  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = 204;
    return;
  }
  await next();
});

// Логирование запросов
app.use(async (ctx, next) => {
  console.log(`${ctx.request.method} ${ctx.request.url.pathname}`);
  await next();
});

// Парсинг JSON тела запроса
app.use(async (ctx, next) => {
  if (ctx.request.hasBody) {
    try {
      const body = ctx.request.body();
      if (body.type === "json") {
        ctx.state.body = await body.value;
      } else if (body.type === "form") {
        const formData = await body.value;
        ctx.state.body = Object.fromEntries(formData.entries());
      }
    } catch (err) {
      console.error("Error parsing body:", err);
    }
  }
  await next();
});

// Генерация ID
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Функция для очистки старых данных (оптимизированная)
async function cleanupOldData() {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.setDate(now.getDate() - 30)).toISOString();
    const sevenDaysAgo = new Date(new Date().setDate(new Date().getDate() - 7)).toISOString().split('T')[0];
    
    // Очистка старых просмотров (старше 7 дней)
    const viewsToDelete = [];
    for await (const entry of kv.list({ prefix: ["views"] })) {
      const date = entry.key[2];
      if (date < sevenDaysAgo) {
        viewsToDelete.push(entry.key);
      }
    }
    
    // Очистка неактивных пользователей (старше 30 дней с малым балансом)
    const usersToDelete = [];
    for await (const entry of kv.list({ prefix: ["users"] })) {
      if (entry.value.createdAt < thirtyDaysAgo && entry.value.balance < 0.01) {
        usersToDelete.push(entry.key);
      }
    }
    
    // Очистка завершенных выводов (старше 30 дней)
    const withdrawalsToDelete = [];
    for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
      if (entry.value.date < thirtyDaysAgo && entry.value.status !== "pending") {
        withdrawalsToDelete.push(entry.key);
      }
    }
    
    // Пакетное удаление
    const batch = kv.atomic();
    viewsToDelete.forEach(key => batch.delete(key));
    usersToDelete.forEach(key => batch.delete(key));
    withdrawalsToDelete.forEach(key => batch.delete(key));
    await batch.commit();
    
    console.log(`Cleanup completed: ${viewsToDelete.length} views, ${usersToDelete.length} users, ${withdrawalsToDelete.length} withdrawals removed`);
  } catch (error) {
    console.error("Cleanup error:", error);
  }
}

// Запускаем очистку при старте и затем каждые 24 часа
cleanupOldData();
setInterval(cleanupOldData, 24 * 60 * 60 * 1000);

// Регистрация пользователя (исправленный эндпоинт)
router.post("/register", async (ctx) => {
  try {
    const { refCode } = ctx.state.body || {};
    const userId = `user_${generateId()}`;
    const userRefCode = generateId().toString();

    const userData = {
      balance: 0,
      refCode: userRefCode,
      refCount: 0,
      refEarnings: 0,
      completedTasks: [],
      createdAt: new Date().toISOString()
    };

    await kv.set(["users", userId], userData);

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
      success: true,
      userId,
      refCode: userRefCode,
      refLink: `https://t.me/Ad_Rew_ards_bot?start=${userRefCode}`
    };
  } catch (error) {
    console.error("Registration error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

// Reward endpoint (работает для GET и POST)
router.all("/reward", async (ctx) => {
  try {
    let userId, secret;
    
    if (ctx.request.method === "POST") {
      const body = ctx.state.body || {};
      userId = body.userId || body.userid;
      secret = body.secret;
    } else {
      userId = ctx.request.url.searchParams.get("userid");
      secret = ctx.request.url.searchParams.get("secret");
    }

    if (!userId) {
      ctx.response.status = 400;
      ctx.response.body = { 
        success: false,
        error: "User ID is required" 
      };
      return;
    }

    if (secret !== CONFIG.SECRET_KEY && secret !== CONFIG.WEBHOOK_SECRET) {
      ctx.response.status = 401;
      ctx.response.body = { 
        success: false,
        error: "Invalid secret" 
      };
      return;
    }

    const user = await kv.get(["users", userId]);
    if (!user.value) {
      ctx.response.status = 404;
      ctx.response.body = { 
        success: false,
        error: "User not found" 
      };
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    const dailyViews = (await kv.get(["views", userId, today])).value || 0;

    if (dailyViews >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 429;
      ctx.response.body = { 
        success: false,
        error: "Daily limit reached" 
      };
      return;
    }

    const newBalance = user.value.balance + CONFIG.REWARD_PER_AD;
    await kv.atomic()
      .set(["users", userId], { ...user.value, balance: newBalance })
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
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

// Получение информации о пользователе
router.get("/user/:userId", async (ctx) => {
  try {
    const userId = ctx.params.userId;
    const user = (await kv.get(["users", userId])).value;
    
    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { 
        success: false,
        error: "User not found" 
      };
      return;
    }
    
    ctx.response.body = {
      success: true,
      ...user,
      completedTasks: user.completedTasks || []
    };
  } catch (error) {
    console.error("Get user error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

// Получение статистики просмотров
router.get("/views/:userId/:date", async (ctx) => {
  try {
    const { userId, date } = ctx.params;
    const views = (await kv.get(["views", userId, date])).value || 0;
    ctx.response.body = {
      success: true,
      views
    };
  } catch (error) {
    console.error("Get views error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

// Вывод средств
router.post("/withdraw", async (ctx) => {
  try {
    const { userId, wallet, amount } = ctx.state.body || {};
    const user = (await kv.get(["users", userId])).value;

    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { 
        success: false,
        error: "User not found" 
      };
      return;
    }

    if (!wallet || !amount) {
      ctx.response.status = 400;
      ctx.response.body = { 
        success: false,
        error: "Wallet and amount are required" 
      };
      return;
    }

    if (amount < CONFIG.MIN_WITHDRAW || user.balance < amount) {
      ctx.response.status = 400;
      ctx.response.body = { 
        success: false,
        error: "Invalid withdrawal amount" 
      };
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

    ctx.response.body = { 
      success: true, 
      withdrawId 
    };
  } catch (error) {
    console.error("Withdraw error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

// Задания
router.get("/tasks", async (ctx) => {
  try {
    const tasks = [];
    for await (const entry of kv.list({ prefix: ["tasks"] })) {
      tasks.push(entry.value);
    }
    
    const customTasks = [];
    for await (const entry of kv.list({ prefix: ["custom_tasks"] })) {
      customTasks.push(entry.value);
    }

    ctx.response.body = {
      success: true,
      tasks: [...tasks, ...customTasks]
    };
  } catch (error) {
    console.error("Get tasks error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

// Завершение задания
router.post("/user/:userId/complete-task", async (ctx) => {
  try {
    const userId = ctx.params.userId;
    const { taskId } = ctx.state.body || {};
    
    const user = (await kv.get(["users", userId])).value;
    
    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { 
        success: false,
        error: "User not found" 
      };
      return;
    }
    
    if (!taskId) {
      ctx.response.status = 400;
      ctx.response.body = { 
        success: false,
        error: "Task ID is required" 
      };
      return;
    }
    
    const completedTasks = user.completedTasks || [];
    if (completedTasks.includes(taskId)) {
      ctx.response.status = 400;
      ctx.response.body = { 
        success: false,
        error: "Task already completed" 
      };
      return;
    }
    
    let task = null;
    
    for await (const entry of kv.list({ prefix: ["tasks"] })) {
      if (entry.value.id === taskId) {
        task = entry.value;
        break;
      }
    }
    
    if (!task) {
      for await (const entry of kv.list({ prefix: ["custom_tasks"] })) {
        if (entry.value.id === taskId) {
          task = entry.value;
          break;
        }
      }
    }
    
    if (!task) {
      ctx.response.status = 404;
      ctx.response.body = { 
        success: false,
        error: "Task not found" 
      };
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
      success: true,
      balance: newBalance,
      completedTasks: newCompletedTasks
    };
  } catch (error) {
    console.error("Complete task error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

// Админ-панель
router.post("/admin/login", async (ctx) => {
  try {
    const { password } = ctx.state.body || {};
    if (password === CONFIG.ADMIN_PASSWORD) {
      ctx.response.body = { 
        success: true, 
        token: "admin_" + generateId() 
      };
    } else {
      ctx.response.status = 401;
      ctx.response.body = { 
        success: false,
        error: "Wrong password" 
      };
    }
  } catch (error) {
    console.error("Admin login error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

// Управление выводом средств (админ)
router.get("/admin/withdrawals", async (ctx) => {
  try {
    const authHeader = ctx.request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      ctx.response.status = 401;
      ctx.response.body = { 
        success: false,
        error: "Unauthorized" 
      };
      return;
    }

    const withdrawals = [];
    for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
      withdrawals.push(entry.value);
    }
    ctx.response.body = {
      success: true,
      withdrawals
    };
  } catch (error) {
    console.error("Get withdrawals error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

router.post("/admin/withdrawals/:id", async (ctx) => {
  try {
    const authHeader = ctx.request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      ctx.response.status = 401;
      ctx.response.body = { 
        success: false,
        error: "Unauthorized" 
      };
      return;
    }

    const { status } = ctx.state.body || {};
    const withdrawal = (await kv.get(["withdrawals", ctx.params.id])).value;

    if (!withdrawal) {
      ctx.response.status = 404;
      ctx.response.body = { 
        success: false,
        error: "Not found" 
      };
      return;
    }

    await kv.set(["withdrawals", ctx.params.id], {
      ...withdrawal,
      status,
      processedAt: new Date().toISOString()
    });

    ctx.response.body = { 
      success: true 
    };
  } catch (error) {
    console.error("Process withdrawal error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

// Управление стандартными заданиями (админ)
router.get("/admin/tasks", async (ctx) => {
  try {
    const authHeader = ctx.request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      ctx.response.status = 401;
      ctx.response.body = { 
        success: false,
        error: "Unauthorized" 
      };
      return;
    }

    const tasks = [];
    for await (const entry of kv.list({ prefix: ["tasks"] })) {
      tasks.push(entry.value);
    }
    
    ctx.response.body = {
      success: true,
      tasks
    };
  } catch (error) {
    console.error("Get tasks error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

router.post("/admin/tasks", async (ctx) => {
  try {
    const authHeader = ctx.request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      ctx.response.status = 401;
      ctx.response.body = { 
        success: false,
        error: "Unauthorized" 
      };
      return;
    }

    const { title, reward, description, url, cooldown } = ctx.state.body || {};
    const taskId = `task_${generateId()}`;
    
    await kv.set(["tasks", taskId], {
      id: taskId,
      title,
      reward: parseFloat(reward),
      description,
      url,
      cooldown: parseInt(cooldown) || 10,
      createdAt: new Date().toISOString(),
      type: "default"
    });
    
    ctx.response.body = { 
      success: true,
      taskId 
    };
  } catch (error) {
    console.error("Add task error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

router.delete("/admin/tasks/:id", async (ctx) => {
  try {
    const authHeader = ctx.request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      ctx.response.status = 401;
      ctx.response.body = { 
        success: false,
        error: "Unauthorized" 
      };
      return;
    }

    await kv.delete(["tasks", ctx.params.id]);
    ctx.response.body = { 
      success: true 
    };
  } catch (error) {
    console.error("Delete task error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

// Управление кастомными заданиями (админ)
router.get("/admin/custom-tasks", async (ctx) => {
  try {
    const authHeader = ctx.request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      ctx.response.status = 401;
      ctx.response.body = { 
        success: false,
        error: "Unauthorized" 
      };
      return;
    }

    const tasks = [];
    for await (const entry of kv.list({ prefix: ["custom_tasks"] })) {
      tasks.push(entry.value);
    }
    
    ctx.response.body = {
      success: true,
      tasks
    };
  } catch (error) {
    console.error("Get custom tasks error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

router.post("/admin/custom-tasks", async (ctx) => {
  try {
    const authHeader = ctx.request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      ctx.response.status = 401;
      ctx.response.body = { 
        success: false,
        error: "Unauthorized" 
      };
      return;
    }

    const { title, reward, description, url, cooldown } = ctx.state.body || {};
    const taskId = `custom_${generateId()}`;
    
    await kv.set(["custom_tasks", taskId], {
      id: taskId,
      title,
      reward: parseFloat(reward),
      description,
      url,
      cooldown: parseInt(cooldown) || 10,
      createdAt: new Date().toISOString(),
      type: "custom"
    });
    
    ctx.response.body = { 
      success: true,
      taskId 
    };
  } catch (error) {
    console.error("Add custom task error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

router.delete("/admin/custom-tasks/:id", async (ctx) => {
  try {
    const authHeader = ctx.request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      ctx.response.status = 401;
      ctx.response.body = { 
        success: false,
        error: "Unauthorized" 
      };
      return;
    }

    await kv.delete(["custom_tasks", ctx.params.id]);
    ctx.response.body = { 
      success: true 
    };
  } catch (error) {
    console.error("Delete custom task error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false,
      error: "Internal server error",
      details: error.message 
    };
  }
});

// Статус сервера
router.get("/", (ctx) => {
  ctx.response.body = {
    success: true,
    status: "OK",
    version: "1.0",
    endpoints: {
      register: "POST /register",
      reward: "GET/POST /reward",
      user: "GET /user/:userId",
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
  ctx.response.body = { 
    success: false,
    error: "Not found" 
  };
});

app.addEventListener("error", (evt) => {
  console.error("Server error:", evt.error);
});

// Запуск сервера
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
