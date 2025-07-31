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
  TELEGRAM_BOT_NAME: "Ad_Rew_ards_bot",
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

// Middleware
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(async (ctx, next) => {
  console.log(`${ctx.request.method} ${ctx.request.url.pathname}`);
  await next();
});

// Helper functions
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

async function cleanupOldData() {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.setDate(now.getDate() - 30)).toISOString();
    
    // Clean old views (keep last 7 days)
    for await (const entry of kv.list({ prefix: ["views"] })) {
      const date = entry.key[2];
      if (date < new Date(new Date().setDate(new Date().getDate() - 7)).toISOString().split('T')[0]) {
        await kv.delete(entry.key);
      }
    }
    
    // Clean inactive users (30+ days inactive with balance < $0.01)
    for await (const entry of kv.list({ prefix: ["users"] })) {
      if (entry.value.createdAt < thirtyDaysAgo && entry.value.balance < 0.01) {
        await kv.delete(entry.key);
        // Clean user's views
        for await (const viewEntry of kv.list({ prefix: ["views", entry.key[1]] })) {
          await kv.delete(viewEntry.key);
        }
      }
    }
    
    // Clean old withdrawals (30+ days completed)
    for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
      if (entry.value.date < thirtyDaysAgo && entry.value.status !== "pending") {
        await kv.delete(entry.key);
      }
    }
    
    console.log("Cleanup completed");
  } catch (error) {
    console.error("Cleanup error:", error);
  }
}

// Routes
router.post("/register", async (ctx) => {
  try {
    const { refCode, telegramId } = await ctx.request.body().value;
    const userId = `user_${generateId()}`;
    const userRefCode = generateId().toString();

    const userData = {
      balance: 0,
      refCode: userRefCode,
      refCount: 0,
      refEarnings: 0,
      completedTasks: [],
      createdAt: new Date().toISOString(),
      telegramId: telegramId || null
    };

    await kv.set(["users", userId], userData);

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

    const telegramRefLink = `https://t.me/${CONFIG.TELEGRAM_BOT_NAME}?start=${userRefCode}`;
    const webRefLink = `${ctx.request.headers.get('origin') || ctx.request.url.origin}?ref=${userRefCode}`;

    ctx.response.body = {
      userId,
      refCode: userRefCode,
      refLink: webRefLink,
      telegramRefLink
    };
  } catch (error) {
    console.error("Registration error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

router.get("/telegram/check-ref/:refCode", async (ctx) => {
  try {
    const refCode = ctx.params.refCode;
    let isValid = false;
    let referrerId = null;

    for await (const entry of kv.list({ prefix: ["users"] })) {
      if (entry.value.refCode === refCode) {
        isValid = true;
        referrerId = entry.key[1];
        break;
      }
    }

    ctx.response.body = { isValid, referrerId };
  } catch (error) {
    console.error("Telegram ref check error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

router.post("/user/:userId/link-telegram", async (ctx) => {
  try {
    const userId = ctx.params.userId;
    const { telegramId } = await ctx.request.body().value;
    
    const user = (await kv.get(["users", userId])).value;
    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }

    await kv.set(["users", userId], {
      ...user,
      telegramId
    });

    ctx.response.body = { success: true };
  } catch (error) {
    console.error("Link Telegram error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

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
      telegramRefLink: `https://t.me/${CONFIG.TELEGRAM_BOT_NAME}?start=${user.refCode}`
    };
  } catch (error) {
    console.error("Get user error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

router.get("/telegram/user/:telegramId", async (ctx) => {
  try {
    const telegramId = ctx.params.telegramId;
    let userData = null;

    for await (const entry of kv.list({ prefix: ["users"] })) {
      if (entry.value.telegramId === telegramId) {
        userData = entry.value;
        userData.userId = entry.key[1];
        break;
      }
    }

    if (!userData) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }

    ctx.response.body = {
      ...userData,
      telegramRefLink: `https://t.me/${CONFIG.TELEGRAM_BOT_NAME}?start=${userData.refCode}`
    };
  } catch (error) {
    console.error("Get Telegram user error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

router.get("/views/:userId/:date", async (ctx) => {
  try {
    const { userId, date } = ctx.params;
    const views = (await kv.get(["views", userId, date])).value || 0;
    ctx.response.body = views;
  } catch (error) {
    console.error("Get views error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

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
    console.error("Reward error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

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
    console.error("Withdraw error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

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
    console.error("Get tasks error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

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
    console.error("Complete task error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Admin routes
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
    console.error("Get withdrawals error:", error);
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
    console.error("Process withdrawal error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
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
    console.error("Get admin tasks error:", error);
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
    console.error("Add task error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

router.delete("/admin/tasks/:id", async (ctx) => {
  try {
    await kv.delete(["custom_tasks", ctx.params.id]);
    ctx.response.body = { success: true };
  } catch (error) {
    console.error("Delete task error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Root endpoint
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "OK",
    version: "1.1",
    telegramBot: `https://t.me/${CONFIG.TELEGRAM_BOT_NAME}`,
    endpoints: {
      register: "POST /register",
      reward: "/reward?userid=USERID&secret=wagner46375",
      withdraw: "POST /withdraw",
      telegram: {
        checkRef: "GET /telegram/check-ref/:refCode",
        linkAccount: "POST /user/:userId/link-telegram",
        getUser: "GET /telegram/user/:telegramId"
      },
      admin: "/admin/login",
      tasks: "GET /tasks",
      completeTask: "POST /user/:userId/complete-task"
    }
  };
});

// Error handling
app.use(async (ctx) => {
  ctx.response.status = 404;
  ctx.response.body = { error: "Not found" };
});

app.addEventListener("error", (evt) => {
  console.error("Server error:", evt.error);
});

// Start server
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
console.log(`Telegram bot: https://t.me/${CONFIG.TELEGRAM_BOT_NAME}`);

// Start cleanup job
cleanupOldData();
setInterval(cleanupOldData, 24 * 60 * 60 * 1000);

await app.listen({ port });
