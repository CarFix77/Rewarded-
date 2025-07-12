import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const CONFIG = {
  SECRET_KEY: "Jora1513",
  REWARD_AMOUNT: 0.0003,
  REF_PERCENT: 0.15,
  MIN_WITHDRAW: 1.00,
  ADMIN_PASSWORD: "AdGramAdmin777",
  DAILY_LIMIT: 30,
  COOLDOWN: 10,
  PORT: 8000
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

app.use(oakCors({ origin: "*" }));
app.use(async (ctx, next) => {
  ctx.response.headers.set("Content-Type", "application/json");
  try {
    await next();
  } catch (err) {
    console.error(err);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Auth middleware
const authMiddleware = async (ctx, next) => {
  const publicRoutes = ["/", "/health", "/api/user", "/api/tasks"];
  if (publicRoutes.some(route => ctx.request.url.pathname.startsWith(route))) {
    return await next();
  }
  
  const token = ctx.request.headers.get("Authorization")?.split(" ")[1];
  if (token && (await kv.get(["admin_tokens", token])).value) {
    return await next();
  }
  
  const key = ctx.request.url.searchParams.get("key") || ctx.request.headers.get("x-api-key");
  if (key !== CONFIG.SECRET_KEY) {
    ctx.response.status = 403;
    ctx.response.body = { error: "Invalid API key" };
    return;
  }
  await next();
};

// Helper functions
function generateReferralCode(userId) {
  return userId.slice(0, 8) + Math.random().toString(36).substr(2, 4).toUpperCase();
}

async function findUserByReferralCode(code) {
  for await (const entry of kv.list({ prefix: ["users"] })) {
    if (entry.value?.referralCode === code) {
      return { userId: entry.key[1], ...entry.value };
    }
  }
  return null;
}

// Routes
router.get("/health", (ctx) => {
  ctx.response.body = { status: "ok" };
});

router.post("/api/user/register", async (ctx) => {
  const { referrerCode } = await ctx.request.body().value;
  const userId = 'user_' + crypto.randomUUID();
  const referralCode = generateReferralCode(userId);
  
  await kv.set(["users", userId], {
    balance: 0,
    referralCode,
    referrals: 0,
    ref_earnings: 0,
    completedTasks: [],
    createdAt: new Date().toISOString()
  });

  if (referrerCode) {
    const referrer = await findUserByReferralCode(referrerCode);
    if (referrer) {
      await kv.set(["users", userId, "referrer"], referrer.userId);
    }
  }

  ctx.response.body = { userId, referralCode };
});

router.get("/api/user/:userId", async (ctx) => {
  const userId = ctx.params.userId;
  const today = new Date().toISOString().split("T")[0];
  
  const [user, adViews] = await Promise.all([
    kv.get(["users", userId]),
    kv.get(["daily", userId, today])
  ]);

  ctx.response.body = {
    ...user.value,
    adViews: adViews.value || 0,
    isAdBlocked: (adViews.value || 0) >= CONFIG.DAILY_LIMIT
  };
});

router.post("/api/user/:userId/watch-ad", async (ctx) => {
  const userId = ctx.params.userId;
  const { ref } = await ctx.request.body().value;
  const today = new Date().toISOString().split("T")[0];
  const dailyKey = ["daily", userId, today];

  const dailyViews = (await kv.get(dailyKey)).value || 0;
  if (dailyViews >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { error: "Daily limit reached" };
    return;
  }

  const tx = kv.atomic()
    .sum(["users", userId, "balance"], CONFIG.REWARD_AMOUNT)
    .sum(dailyKey, 1);

  if (ref && ref !== userId) {
    const refReward = CONFIG.REWARD_AMOUNT * CONFIG.REF_PERCENT;
    tx
      .sum(["users", ref, "balance"], refReward)
      .sum(["users", ref, "ref_earnings"], refReward)
      .sum(["users", ref, "referrals"], 1);
  }

  await tx.commit();

  ctx.response.body = await kv.get(["users", userId]);
});

router.post("/api/withdrawals", async (ctx) => {
  const { userId, wallet, amount } = await ctx.request.body().value;
  
  if (amount < CONFIG.MIN_WITHDRAW) {
    ctx.response.status = 400;
    ctx.response.body = { error: `Minimum withdraw is $${CONFIG.MIN_WITHDRAW}` };
    return;
  }

  const user = (await kv.get(["users", userId])).value;
  if (!user || user.balance < amount) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Insufficient balance" };
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const adViews = (await kv.get(["daily", userId, today])).value || 0;

  const withdrawalId = crypto.randomUUID();
  await kv.atomic()
    .set(["withdrawals", withdrawalId], {
      userId,
      amount,
      wallet,
      adViews,
      status: "pending",
      date: new Date().toISOString()
    })
    .sum(["users", userId, "balance"], -amount)
    .commit();

  ctx.response.body = { success: true };
});

// Admin routes
router.post("/api/admin/login", async (ctx) => {
  const { password } = await ctx.request.body().value;
  
  if (password !== CONFIG.ADMIN_PASSWORD) {
    ctx.response.status = 403);
    ctx.response.body = { error: "Invalid password" };
    return;
  }

  const token = crypto.randomUUID();
  await kv.set(["admin_tokens", token], { 
    valid: true, 
    expires: Date.now() + 86400000
  });
  
  ctx.response.body = { token };
});

router.get("/api/admin/withdrawals", authMiddleware, async (ctx) => {
  const status = ctx.request.url.searchParams.get("status");
  const withdrawals = [];
  
  for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
    if (!status || entry.value.status === status) {
      const user = (await kv.get(["users", entry.value.userId])).value || {};
      withdrawals.push({
        id: entry.key[1],
        ...entry.value,
        user: {
          balance: user.balance,
          adViews: entry.value.adViews
        }
      });
    }
  }
  
  ctx.response.body = withdrawals;
});

router.put("/api/admin/withdrawals/:id", authMiddleware, async (ctx) => {
  const { status } = await ctx.request.body().value;
  const id = ctx.params.id;
  
  const withdrawal = (await kv.get(["withdrawals", id])).value;
  if (!withdrawal) {
    ctx.response.status = 404);
    ctx.response.body = { error: "Withdrawal not found" };
    return;
  }
  
  await kv.set(["withdrawals", id], { ...withdrawal, status });
  ctx.response.body = { success: true };
});

router.post("/api/admin/tasks", authMiddleware, async (ctx) => {
  const task = await ctx.request.body().value;
  const taskId = crypto.randomUUID();
  
  await kv.set(["tasks", taskId], { 
    ...task, 
    id: taskId,
    createdAt: new Date().toISOString()
  });
  
  ctx.response.body = { ...task, id: taskId };
});

router.get("/api/admin/tasks", authMiddleware, async (ctx) => {
  const tasks = [];
  for await (const entry of kv.list({ prefix: ["tasks"] })) {
    tasks.push(entry.value);
  }
  ctx.response.body = tasks;
});

router.delete("/api/admin/tasks/:id", authMiddleware, async (ctx) => {
  await kv.delete(["tasks", ctx.params.id]);
  ctx.response.body = { success: true };
});

app.use(router.routes());
app.use(router.allowedMethods());

console.log(`Server running on port ${CONFIG.PORT}`);
await app.listen({ port: CONFIG.PORT });
