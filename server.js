import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223"
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// CORS Middleware
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

// Logging Middleware
app.use(async (ctx, next) => {
  console.log(`${ctx.request.method} ${ctx.request.url.pathname}`);
  await next();
});

// JSON Body Parser
app.use(async (ctx, next) => {
  if (ctx.request.hasBody) {
    try {
      const body = ctx.request.body();
      if (body.type === "json") {
        ctx.state.body = await body.value;
      }
    } catch (err) {
      console.error("Body parse error:", err);
    }
  }
  await next();
});

app.use(router.routes());
app.use(router.allowedMethods());

// Helper Functions
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// API Endpoints

// Health Check
router.get("/", (ctx) => {
  ctx.response.body = { 
    status: "running",
    endpoints: {
      register: "POST /register",
      reward: "GET /reward?userid=ID&secret=KEY",
      user: "GET /user/USER_ID",
      withdraw: "POST /withdraw"
    }
  };
});

// User Registration
router.post("/register", async (ctx) => {
  try {
    const userId = `user_${generateId()}`;
    const refCode = generateId().toString();
    
    await kv.set(["users", userId], {
      balance: 0,
      refCode,
      refCount: 0,
      refEarnings: 0,
      createdAt: new Date().toISOString()
    });

    ctx.response.body = {
      success: true,
      userId,
      refCode,
      refLink: `https://t.me/Ad_Rew_ards_bot?start=${refCode}`
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Registration failed" };
  }
});

// Get User Info
router.get("/user/:userId", async (ctx) => {
  try {
    const user = (await kv.get(["users", ctx.params.userId])).value;
    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { success: false, error: "User not found" };
      return;
    }
    ctx.response.body = { success: true, ...user };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Server error" };
  }
});

// Reward Processing
router.get("/reward", async (ctx) => {
  try {
    const userId = ctx.request.url.searchParams.get("userid");
    const secret = ctx.request.url.searchParams.get("secret");

    // Input validation
    if (!userId || !secret) {
      ctx.response.status = 400;
      ctx.response.body = { success: false, error: "Missing parameters" };
      return;
    }

    if (secret !== CONFIG.SECRET_KEY) {
      ctx.response.status = 401;
      ctx.response.body = { success: false, error: "Invalid secret" };
      return;
    }

    const user = (await kv.get(["users", userId])).value;
    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { success: false, error: "User not found" };
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    const viewsToday = (await kv.get(["views", userId, today])).value || 0;

    if (viewsToday >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 429;
      ctx.response.body = { success: false, error: "Daily limit reached" };
      return;
    }

    const newBalance = user.balance + CONFIG.REWARD_PER_AD;
    
    // Atomic update
    await kv.atomic()
      .set(["users", userId], { ...user, balance: newBalance })
      .set(["views", userId, today], viewsToday + 1)
      .commit();

    ctx.response.body = {
      success: true,
      reward: CONFIG.REWARD_PER_AD,
      balance: newBalance,
      viewsToday: viewsToday + 1
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Reward processing failed" };
  }
});

// Withdrawal Request
router.post("/withdraw", async (ctx) => {
  try {
    const { userId, wallet, amount } = ctx.state.body || {};
    
    // Input validation
    if (!userId || !wallet || !amount) {
      ctx.response.status = 400;
      ctx.response.body = { success: false, error: "Missing parameters" };
      return;
    }

    const user = (await kv.get(["users", userId])).value;
    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { success: false, error: "User not found" };
      return;
    }

    if (amount < CONFIG.MIN_WITHDRAW || user.balance < amount) {
      ctx.response.status = 400;
      ctx.response.body = { success: false, error: "Invalid amount" };
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
      withdrawId,
      newBalance: user.balance - amount
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Withdrawal failed" };
  }
});

// Admin Endpoints
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
      ctx.response.body = { success: false, error: "Invalid password" };
    }
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Login failed" };
  }
});

// Error Handling
app.use((ctx) => {
  ctx.response.status = 404;
  ctx.response.body = { success: false, error: "Endpoint not found" };
});

// Start Server
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
