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

// ================== MIDDLEWARES ================== //

// 1. Глобальная обработка ошибок
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error("Server error:", err);
    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      error: "Internal server error",
      details: err.message
    };
  }
});

// 2. CORS middleware
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// 3. Парсинг тела запроса
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
      console.error("Body parsing error:", err);
    }
  }
  await next();
});

// ================== HELPERS ================== //

function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

async function cleanupOldData() {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.setDate(now.getDate() - 30)).toISOString();
    const sevenDaysAgo = new Date(new Date().setDate(new Date().getDate() - 7)).toISOString().split('T')[0];
    
    const batch = kv.atomic();
    let count = 0;

    // Clean old views (>7 days)
    for await (const entry of kv.list({ prefix: ["views"] })) {
      if (entry.key[2] < sevenDaysAgo) {
        batch.delete(entry.key);
        count++;
      }
    }

    // Clean inactive users (>30 days, balance < $0.01)
    for await (const entry of kv.list({ prefix: ["users"] })) {
      if (entry.value.createdAt < thirtyDaysAgo && entry.value.balance < 0.01) {
        batch.delete(entry.key);
        // Delete user's views
        for await (const viewEntry of kv.list({ prefix: ["views", entry.key[1]] })) {
          batch.delete(viewEntry.key);
        }
        count++;
      }
    }

    // Clean processed withdrawals (>30 days)
    for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
      if (entry.value.date < thirtyDaysAgo && entry.value.status !== "pending") {
        batch.delete(entry.key);
        count++;
      }
    }

    await batch.commit();
    console.log(`Cleanup completed. Removed ${count} items.`);
  } catch (error) {
    console.error("Cleanup error:", error);
  }
}

// Schedule cleanup every 24 hours
setInterval(cleanupOldData, 24 * 60 * 60 * 1000);
cleanupOldData();

// ================== ROUTES ================== //

// Регистрация пользователя
router.post("/register", async (ctx) => {
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
});

// Получение награды
router.all("/reward", async (ctx) => {
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
    ctx.response.body = { success: false, error: "User ID is required" };
    return;
  }

  if (secret !== CONFIG.SECRET_KEY && secret !== CONFIG.WEBHOOK_SECRET) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Invalid secret" };
    return;
  }

  const user = await kv.get(["users", userId]);
  if (!user.value) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "User not found" };
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const dailyViews = (await kv.get(["views", userId, today])).value || 0;

  if (dailyViews >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { success: false, error: "Daily limit reached" };
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
});

// Получение информации о пользователе
router.get("/user/:userId", async (ctx) => {
  const userId = ctx.params.userId;
  const user = (await kv.get(["users", userId])).value;
  
  if (!user) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "User not found" };
    return;
  }
  
  ctx.response.body = {
    success: true,
    ...user,
    completedTasks: user.completedTasks || []
  };
});

// Статистика просмотров
router.get("/views/:userId/:date", async (ctx) => {
  const { userId, date } = ctx.params;
  const views = (await kv.get(["views", userId, date])).value || 0;
  ctx.response.body = { success: true, views };
});

// Вывод средств
router.post("/withdraw", async (ctx) => {
  const { userId, wallet, amount } = ctx.state.body || {};
  const user = (await kv.get(["users", userId])).value;

  if (!user) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "User not found" };
    return;
  }

  if (!wallet || !amount) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Wallet and amount are required" };
    return;
  }

  if (amount < CONFIG.MIN_WITHDRAW || user.balance < amount) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid withdrawal amount" };
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
});

// Завершение задания
router.post("/user/:userId/complete-task", async (ctx) => {
  const userId = ctx.params.userId;
  const { taskId } = ctx.state.body || {};
  
  const user = (await kv.get(["users", userId])).value;
  
  if (!user) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "User not found" };
    return;
  }
  
  if (!taskId) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Task ID is required" };
    return;
  }
  
  const completedTasks = user.completedTasks || [];
  if (completedTasks.includes(taskId)) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Task already completed" };
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
    ctx.response.body = { success: false, error: "Task not found" };
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
});

// ================== ADMIN ROUTES ================== //

router.post("/admin/login", async (ctx) => {
  const { password } = ctx.state.body || {};
  if (password === CONFIG.ADMIN_PASSWORD) {
    ctx.response.body = { success: true, token: "admin_" + generateId() };
  } else {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Wrong password" };
  }
});

router.get("/admin/withdrawals", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  const withdrawals = [];
  for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
    withdrawals.push(entry.value);
  }
  ctx.response.body = { success: true, withdrawals };
});

router.post("/admin/withdrawals/:id", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  const { status } = ctx.state.body || {};
  const withdrawal = (await kv.get(["withdrawals", ctx.params.id])).value;

  if (!withdrawal) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Not found" };
    return;
  }

  await kv.set(["withdrawals", ctx.params.id], {
    ...withdrawal,
    status,
    processedAt: new Date().toISOString()
  });

  ctx.response.body = { success: true };
});

router.get("/admin/tasks", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  const tasks = [];
  for await (const entry of kv.list({ prefix: ["tasks"] })) {
    tasks.push(entry.value);
  }
  ctx.response.body = { success: true, tasks };
});

router.post("/admin/tasks", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
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
  
  ctx.response.body = { success: true, taskId };
});

router.delete("/admin/tasks/:id", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  await kv.delete(["tasks", ctx.params.id]);
  ctx.response.body = { success: true };
});

router.get("/admin/custom-tasks", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  const tasks = [];
  for await (const entry of kv.list({ prefix: ["custom_tasks"] })) {
    tasks.push(entry.value);
  }
  ctx.response.body = { success: true, tasks };
});

router.post("/admin/custom-tasks", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
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
  
  ctx.response.body = { success: true, taskId };
});

router.delete("/admin/custom-tasks/:id", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  await kv.delete(["custom_tasks", ctx.params.id]);
  ctx.response.body = { success: true };
});

// ================== SERVER SETUP ================== //

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

app.use(router.routes());
app.use(router.allowedMethods());

app.use((ctx) => {
  ctx.response.status = 404;
  ctx.response.body = { success: false, error: "Endpoint not found" };
});

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
