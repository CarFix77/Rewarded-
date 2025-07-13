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

// Enhanced CORS configuration
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
  credentials: true
}));

// Handle OPTIONS requests
app.use(async (ctx, next) => {
  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = 200;
    return;
  }
  await next();
});

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

// Routes
router.get("/health", (ctx) => {
  ctx.response.body = { status: "ok", version: "1.0.0", server: "AdRewards+" };
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

  ctx.response.body = { userId, referralCode };
});

router.get("/api/user/:userId", async (ctx) => {
  const userId = ctx.params.userId;
  const today = new Date().toISOString().split("T")[0];
  
  const user = await kv.get(["users", userId]);
  if (!user.value) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User not found" };
    return;
  }

  const adViews = (await kv.get(["daily", userId, today])).value || 0;
  
  ctx.response.body = {
    ...user.value,
    adViews,
    isAdBlocked: adViews >= CONFIG.DAILY_LIMIT
  };
});

router.post("/api/user/:userId/watch-ad", async (ctx) => {
  const userId = ctx.params.userId;
  const today = new Date().toISOString().split("T")[0];
  const dailyKey = ["daily", userId, today];

  const dailyViews = (await kv.get(dailyKey)).value || 0;
  if (dailyViews >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { error: "Daily limit reached" };
    return;
  }

  await kv.atomic()
    .sum(["users", userId, "balance"], CONFIG.REWARD_AMOUNT)
    .sum(dailyKey, 1)
    .commit();

  const updatedUser = await kv.get(["users", userId]);
  ctx.response.body = updatedUser.value;
});

// Остальные роуты остаются без изменений...

app.use(router.routes());
app.use(router.allowedMethods());

console.log(`Server running on port ${CONFIG.PORT}`);
await app.listen({ port: CONFIG.PORT });
