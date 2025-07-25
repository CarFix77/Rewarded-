import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223",
  SECRET_KEY: "wagner46375",
  TASK_REWARDS: {
    subscribe: 0.009,
    view_post: 0.0005,
    like: 0.0003,
    repost: 0.001
  },
  TASK_COOLDOWNS: {
    subscribe: 86400,
    view_post: 3600,
    like: 1800,
    repost: 43200
  }
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// CORS Middleware
app.use(oakCors({ origin: "*" }));

// Helper Functions
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

function getToday() {
  return new Date().toISOString().split("T")[0];
}

// ==================== USER ENDPOINTS ====================

// Register New User
router.post("/register", async (ctx) => {
  const { refCode } = await ctx.request.body().value;
  const userId = `user_${generateId()}`;
  const userRefCode = `ref_${generateId()}`;

  await kv.set(["users", userId], {
    balance: 0,
    refCode: userRefCode,
    refCount: 0,
    refEarnings: 0,
    completedTasks: [],
    createdAt: new Date().toISOString(),
    lastActive: getToday()
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

  ctx.response.body = {
    userId,
    refCode: userRefCode,
    refLink: `${ctx.request.url.origin}?ref=${userRefCode}`
  };
});

// Get User Info
router.get("/user/:userId", async (ctx) => {
  const user = (await kv.get(["users", ctx.params.userId])).value;
  if (!user) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User not found" };
    return;
  }
  
  ctx.response.body = {
    balance: user.balance,
    refCount: user.refCount,
    refEarnings: user.refEarnings,
    refCode: user.refCode,
    completedTasks: user.completedTasks || []
  };
});

// Ad Reward
router.get("/reward", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  const secret = ctx.request.url.searchParams.get("secret");

  if (secret !== CONFIG.SECRET_KEY) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid secret" };
    return;
  }

  const today = getToday();
  const user = (await kv.get(["users", userId])).value || { balance: 0 };
  const dailyViews = (await kv.get(["views", userId, today])).value || 0;

  if (dailyViews >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { error: "Daily limit reached" };
    return;
  }

  const newBalance = user.balance + CONFIG.REWARD_PER_AD;
  await kv.atomic()
    .set(["users", userId], { 
      ...user, 
      balance: newBalance,
      lastActive: today
    })
    .set(["views", userId, today], dailyViews + 1)
    .commit();

  ctx.response.body = {
    success: true,
    reward: CONFIG.REWARD_PER_AD,
    balance: newBalance,
    viewsToday: dailyViews + 1,
    viewsLeft: CONFIG.DAILY_LIMIT - (dailyViews + 1)
  };
});

// Get Available Tasks
router.get("/tasks", (ctx) => {
  ctx.response.body = Object.entries(CONFIG.TASK_REWARDS).map(([type, reward]) => ({
    type,
    reward,
    cooldown: CONFIG.TASK_COOLDOWNS[type]
  }));
});

// Complete Task
router.post("/complete-task", async (ctx) => {
  const { userId, taskType } = await ctx.request.body().value;
  
  if (!CONFIG.TASK_REWARDS[taskType]) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Invalid task type" };
    return;
  }

  const user = (await kv.get(["users", userId])).value;
  if (!user) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User not found" };
    return;
  }

  // Check cooldown
  const lastCompleted = user.completedTasks?.find(t => t.type === taskType);
  if (lastCompleted) {
    const cooldownMs = CONFIG.TASK_COOLDOWNS[taskType] * 1000;
    if (Date.now() - new Date(lastCompleted.date).getTime() < cooldownMs) {
      ctx.response.status = 429;
      ctx.response.body = { error: "Task cooldown active" };
      return;
    }
  }

  const reward = CONFIG.TASK_REWARDS[taskType];
  const newBalance = user.balance + reward;
  
  await kv.set(["users", userId], {
    ...user,
    balance: newBalance,
    lastActive: getToday(),
    completedTasks: [
      ...(user.completedTasks || []),
      {
        type: taskType,
        date: new Date().toISOString(),
        reward: reward
      }
    ]
  });

  ctx.response.body = {
    success: true,
    reward,
    balance: newBalance,
    taskType,
    nextAvailable: Date.now() + (CONFIG.TASK_COOLDOWNS[taskType] * 1000)
  };
});

// Withdraw Funds
router.post("/withdraw", async (ctx) => {
  const { userId, wallet, amount } = await ctx.request.body().value;
  const user = (await kv.get(["users", userId])).value;

  if (!user || amount < CONFIG.MIN_WITHDRAW || user.balance < amount) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Invalid withdrawal request" };
    return;
  }

  const withdrawId = `wd_${generateId()}`;
  await kv.atomic()
    .set(["users", userId], { 
      ...user, 
      balance: user.balance - amount 
    })
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
    withdrawId,
    newBalance: user.balance - amount
  };
});

// ==================== ADMIN ENDPOINTS ====================

// Admin Middleware
const requireAdmin = async (ctx, next) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (authHeader !== `Bearer ${CONFIG.ADMIN_PASSWORD}`) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Unauthorized" };
    return;
  }
  await next();
};

// Admin Login
router.post("/admin/login", async (ctx) => {
  const { password } = await ctx.request.body().value;
  if (password === CONFIG.ADMIN_PASSWORD) {
    ctx.response.body = { 
      success: true,
      token: `Bearer ${CONFIG.ADMIN_PASSWORD}`
    };
  } else {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid credentials" };
  }
});

// Get Withdrawals
router.get("/admin/withdrawals", requireAdmin, async (ctx) => {
  const status = ctx.request.url.searchParams.get("status") || "pending";
  const withdrawals = [];
  
  for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
    if (status === "all" || entry.value.status === status) {
      withdrawals.push(entry.value);
    }
  }
  
  ctx.response.body = withdrawals;
});

// Process Withdrawal
router.post("/admin/withdrawals/:id", requireAdmin, async (ctx) => {
  const { status } = await ctx.request.body().value;
  const withdrawal = (await kv.get(["withdrawals", ctx.params.id])).value;

  if (!withdrawal) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Withdrawal not found" };
    return;
  }

  await kv.set(["withdrawals", ctx.params.id], {
    ...withdrawal,
    status,
    processedAt: new Date().toISOString()
  });

  ctx.response.body = { success: true };
});

// System Stats
router.get("/admin/stats", requireAdmin, async (ctx) => {
  const today = getToday();
  const stats = {
    totalUsers: 0,
    activeToday: 0,
    totalBalance: 0,
    totalWithdrawals: 0,
    pendingWithdrawals: 0,
    completedWithdrawals: 0
  };

  for await (const entry of kv.list({ prefix: ["users"] })) {
    stats.totalUsers++;
    stats.totalBalance += entry.value.balance || 0;
    if (entry.value.lastActive === today) stats.activeToday++;
  }

  for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
    stats.totalWithdrawals++;
    if (entry.value.status === "pending") stats.pendingWithdrawals++;
    if (entry.value.status === "completed") stats.completedWithdrawals++;
  }

  ctx.response.body = stats;
});

// ==================== SERVER START ====================
app.use(router.routes());
app.use(router.allowedMethods());

console.log("Server running on http://localhost:8000");
await app.listen({ port: 8000 });
