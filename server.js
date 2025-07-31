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
  TELEGRAM_BOT_LINK: "https://t.me/Ad_Rew_ards_bot",
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

// CORS Middleware
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Logging Middleware
app.use(async (ctx, next) => {
  console.log(`${ctx.request.method} ${ctx.request.url.pathname}`);
  await next();
});

// Helper Functions
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Routes

// User Registration
router.post("/register", async (ctx) => {
  try {
    const { refCode } = await ctx.request.body().value;
    const userId = `user_${generateId()}`;
    const userRefCode = generateId().toString();

    await kv.set(["users", userId], {
      balance: 0,
      refCode: userRefCode,
      refCount: 0,
      refEarnings: 0,
      completedTasks: [],
      createdAt: new Date().toISOString()
    });

    // Handle referral
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

    const telegramRefLink = `${CONFIG.TELEGRAM_BOT_LINK}?start=${userRefCode}`;
    const webRefLink = `${ctx.request.headers.get('origin') || ctx.request.url.origin}?ref=${userRefCode}`;

    ctx.response.body = {
      userId,
      refCode: userRefCode,
      webRefLink,
      telegramRefLink
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Registration failed" };
  }
});

// Get User Info
router.get("/user/:userId", async (ctx) => {
  try {
    const userId = ctx.params.userId;
    const user = (await kv.get(["users", userId])).value;
    
    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }
    
    ctx.response.body = {
      ...user,
      completedTasks: user.completedTasks || [],
      webRefLink: `${ctx.request.headers.get('origin') || ctx.request.url.origin}?ref=${user.refCode}`,
      telegramRefLink: `${CONFIG.TELEGRAM_BOT_LINK}?start=${user.refCode}`
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to get user" };
  }
});

// Reward Endpoint
router.get("/reward", async (ctx) => {
  try {
    const userId = ctx.request.url.searchParams.get("userid");
    const secret = ctx.request.url.searchParams.get("secret");

    if (!userId || !secret) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing parameters" };
      return;
    }

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
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Reward processing failed" };
  }
});

// Withdraw Funds
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
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Withdrawal failed" };
  }
});

// Tasks Endpoints
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
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to get tasks" };
  }
});

// Complete Task
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
    
    await kv.set(["users", userId], {
      ...user,
      balance: newBalance,
      completedTasks: newCompletedTasks
    });
    
    ctx.response.body = {
      balance: newBalance,
      completedTasks: newCompletedTasks
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to complete task" };
  }
});

// Admin Endpoints
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
    ctx.response.status = 500;
    ctx.response.body = { error: "Admin login failed" };
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
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to get withdrawals" };
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
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to process withdrawal" };
  }
});

router.get("/admin/tasks", async (ctx) => {
  try {
    const customTasks = [];
    for await (const entry of kv.list({ prefix: ["custom_tasks"] })) {
      customTasks.push(entry.value);
    }
    
    ctx.response.body = customTasks;
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to get tasks" };
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
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to add task" };
  }
});

router.delete("/admin/tasks/:id", async (ctx) => {
  try {
    await kv.delete(["custom_tasks", ctx.params.id]);
    ctx.response.body = { success: true };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to delete task" };
  }
});

// Root Endpoint
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "OK",
    version: "1.0",
    endpoints: {
      register: "POST /register",
      getUser: "GET /user/:userId",
      reward: "GET /reward?userid=USERID&secret=SECRET",
      withdraw: "POST /withdraw",
      tasks: "GET /tasks",
      completeTask: "POST /user/:userId/complete-task",
      admin: {
        login: "POST /admin/login",
        withdrawals: "GET /admin/withdrawals",
        processWithdrawal: "POST /admin/withdrawals/:id",
        tasks: "GET /admin/tasks",
        addTask: "POST /admin/tasks",
        deleteTask: "DELETE /admin/tasks/:id"
      }
    }
  };
});

// 404 Handler
app.use((ctx) => {
  ctx.response.status = 404;
  ctx.response.body = { error: "Endpoint not found" };
});

// Error Handler
app.addEventListener("error", (evt) => {
  console.error("Server error:", evt.error);
});

// Start Server
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
