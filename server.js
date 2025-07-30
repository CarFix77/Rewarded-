import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";

// Configuration
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
  PORT: parseInt(Deno.env.get("PORT")) || 8000
};

// Initialize KV and app
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

function getToday() {
  return new Date().toISOString().split("T")[0];
}

function validateWithdrawal(wallet, amount, balance) {
  if (!/^P\d{7,}$/.test(wallet)) return "Invalid PAYEER wallet format";
  if (isNaN(amount) || amount <= 0) return "Invalid amount";
  if (amount < CONFIG.MIN_WITHDRAW) return `Minimum withdrawal is $${CONFIG.MIN_WITHDRAW}`;
  if (amount > balance) return "Insufficient funds";
  return null;
}

// Error handler
async function handleError(ctx, error) {
  console.error("Error:", error);
  ctx.response.status = 500;
  ctx.response.body = { error: "Internal server error" };
}

// Routes

// User registration
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
  } catch (error) {
    handleError(ctx, error);
  }
});

// Get user info
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
      completedTasks: user.completedTasks || []
    };
  } catch (error) {
    handleError(ctx, error);
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

    const today = getToday();
    const userKey = ["users", userId];
    const viewsKey = ["views", userId, today];

    const [userRes, viewsRes] = await kv.getMany([userKey, viewsKey]);
    const user = userRes.value || { balance: 0 };
    const dailyViews = viewsRes.value || 0;

    if (dailyViews >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 429;
      ctx.response.body = { error: "Daily limit reached" };
      return;
    }

    const newBalance = user.balance + CONFIG.REWARD_PER_AD;
    const newViews = dailyViews + 1;

    await kv.atomic()
      .set(userKey, { ...user, balance: newBalance })
      .set(viewsKey, newViews)
      .commit();

    ctx.response.body = {
      success: true,
      reward: CONFIG.REWARD_PER_AD,
      balance: newBalance,
      viewsToday: newViews
    };
  } catch (error) {
    handleError(ctx, error);
  }
});

// Withdrawal
router.post("/withdraw", async (ctx) => {
  try {
    const { userId, wallet, amount } = await ctx.request.body().value;
    const user = (await kv.get(["users", userId])).value;

    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }

    const error = validateWithdrawal(wallet, amount, user.balance);
    if (error) {
      ctx.response.status = 400;
      ctx.response.body = { error };
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
    handleError(ctx, error);
  }
});

// Tasks
const DEFAULT_TASKS = [
  {
    id: "follow_twitter",
    title: "Follow Twitter",
    description: "Follow our Twitter account",
    reward: CONFIG.TASK_REWARDS.FOLLOW,
    url: "https://twitter.com",
    cooldown: 10
  },
  {
    id: "like_tweet",
    title: "Like Tweet",
    description: "Like our latest tweet",
    reward: CONFIG.TASK_REWARDS.LIKE,
    url: "https://twitter.com/tweet",
    cooldown: 10
  },
  {
    id: "retweet",
    title: "Retweet",
    description: "Retweet our message",
    reward: CONFIG.TASK_REWARDS.RETWEET,
    url: "https://twitter.com/retweet",
    cooldown: 15
  },
  {
    id: "comment",
    title: "Leave Comment",
    description: "Comment on our post",
    reward: CONFIG.TASK_REWARDS.COMMENT,
    url: "https://twitter.com/comment",
    cooldown: 20
  }
];

router.get("/tasks", async (ctx) => {
  try {
    const customTasks = [];
    for await (const entry of kv.list({ prefix: ["custom_tasks"] })) {
      customTasks.push(entry.value);
    }
    ctx.response.body = [...DEFAULT_TASKS, ...customTasks];
  } catch (error) {
    handleError(ctx, error);
  }
});

// Complete task
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
    
    if ((user.completedTasks || []).includes(taskId)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Task already completed" };
      return;
    }
    
    const tasks = [...DEFAULT_TASKS];
    for await (const entry of kv.list({ prefix: ["custom_tasks"] })) {
      tasks.push(entry.value);
    }
    
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Task not found" };
      return;
    }
    
    const newBalance = user.balance + task.reward;
    const newCompletedTasks = [...(user.completedTasks || []), taskId];
    
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
    handleError(ctx, error);
  }
});

// Admin endpoints
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
    handleError(ctx, error);
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
    handleError(ctx, error);
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
    handleError(ctx, error);
  }
});

// Admin task management
router.get("/admin/tasks", async (ctx) => {
  try {
    const customTasks = [];
    for await (const entry of kv.list({ prefix: ["custom_tasks"] })) {
      customTasks.push(entry.value);
    }
    ctx.response.body = customTasks;
  } catch (error) {
    handleError(ctx, error);
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
    handleError(ctx, error);
  }
});

router.delete("/admin/tasks/:id", async (ctx) => {
  try {
    await kv.delete(["custom_tasks", ctx.params.id]);
    ctx.response.body = { success: true };
  } catch (error) {
    handleError(ctx, error);
  }
});

// Status endpoint
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

// Error handling
app.use(async (ctx) => {
  ctx.response.status = 404;
  ctx.response.body = { error: "Not found" };
});

app.addEventListener("error", (evt) => {
  console.error("Server error:", evt.error);
});

// Start server
app.use(router.routes());
app.use(router.allowedMethods());

console.log(`Server running on port ${CONFIG.PORT}`);
await app.listen({ port: CONFIG.PORT });
