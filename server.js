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
  FIREBASE_URL: "https://ggggitz-default-rtdb.firebaseio.com",
  FIREBASE_SECRET: Deno.env.get("FIREBASE_SECRET") || "your-database-secret"
};

const app = new Application();
const router = new Router();

// ================== FIREBASE HELPERS ================== //

async function firebaseGet(path: string): Promise<any> {
  try {
    const res = await fetch(`${CONFIG.FIREBASE_URL}/${path}.json?auth=${CONFIG.FIREBASE_SECRET}`);
    return await res.json();
  } catch (error) {
    console.error("Firebase GET error:", error);
    return null;
  }
}

async function firebaseSet(path: string, data: any): Promise<boolean> {
  try {
    const res = await fetch(`${CONFIG.FIREBASE_URL}/${path}.json?auth=${CONFIG.FIREBASE_SECRET}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    return res.ok;
  } catch (error) {
    console.error("Firebase SET error:", error);
    return false;
  }
}

async function firebaseUpdate(path: string, updates: any): Promise<boolean> {
  try {
    const res = await fetch(`${CONFIG.FIREBASE_URL}/${path}.json?auth=${CONFIG.FIREBASE_SECRET}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates)
    });
    return res.ok;
  } catch (error) {
    console.error("Firebase UPDATE error:", error);
    return false;
  }
}

async function firebasePush(path: string, data: any): Promise<string | null> {
  try {
    const res = await fetch(`${CONFIG.FIREBASE_URL}/${path}.json?auth=${CONFIG.FIREBASE_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    const result = await res.json();
    return result.name; // Returns the new ID
  } catch (error) {
    console.error("Firebase PUSH error:", error);
    return null;
  }
}

async function firebaseDelete(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${CONFIG.FIREBASE_URL}/${path}.json?auth=${CONFIG.FIREBASE_SECRET}`, {
      method: "DELETE"
    });
    return res.ok;
  } catch (error) {
    console.error("Firebase DELETE error:", error);
    return false;
  }
}

// ================== MIDDLEWARES ================== //

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

app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

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

function generateId(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ================== ROUTES ================== //

router.post("/register", async (ctx) => {
  const { refCode } = ctx.state.body || {};
  const userId = `user_${generateId()}`;
  const userRefCode = generateId();

  const userData = {
    balance: 0,
    refCode: userRefCode,
    refCount: 0,
    refEarnings: 0,
    completedTasks: [],
    createdAt: new Date().toISOString()
  };

  await firebaseSet(`users/${userId}`, userData);

  if (refCode) {
    const users = await firebaseGet("users");
    if (users) {
      const referrerEntry = Object.entries(users).find(([_, u]: any) => u.refCode === refCode);
      if (referrerEntry) {
        const [referrerId, referrer] = referrerEntry;
        const bonus = CONFIG.REWARD_PER_AD * CONFIG.REFERRAL_PERCENT;
        await firebaseUpdate(`users/${referrerId}`, {
          refCount: referrer.refCount + 1,
          refEarnings: referrer.refEarnings + bonus,
          balance: referrer.balance + bonus
        });
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

  const user = await firebaseGet(`users/${userId}`);
  if (!user) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "User not found" };
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const dailyViews = await firebaseGet(`views/${userId}/${today}`) || 0;

  if (dailyViews >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { success: false, error: "Daily limit reached" };
    return;
  }

  const newBalance = user.balance + CONFIG.REWARD_PER_AD;
  await firebaseUpdate(`users/${userId}`, { balance: newBalance });
  await firebaseSet(`views/${userId}/${today}`, dailyViews + 1);

  ctx.response.body = {
    success: true,
    reward: CONFIG.REWARD_PER_AD,
    balance: newBalance,
    viewsToday: dailyViews + 1
  };
});

router.get("/user/:userId", async (ctx) => {
  const userId = ctx.params.userId;
  const user = await firebaseGet(`users/${userId}`);
  
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

router.post("/withdraw", async (ctx) => {
  const { userId, wallet, amount } = ctx.state.body || {};
  const user = await firebaseGet(`users/${userId}`);

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
  await firebaseUpdate(`users/${userId}`, { balance: user.balance - amount });
  
  await firebaseSet(`withdrawals/${withdrawId}`, {
    userId,
    amount,
    wallet,
    date: new Date().toISOString(),
    status: "pending"
  });

  ctx.response.body = { success: true, withdrawId };
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

  const withdrawals = await firebaseGet("withdrawals") || {};
  ctx.response.body = { 
    success: true, 
    withdrawals: Object.entries(withdrawals).map(([id, data]: any) => ({ id, ...data })) 
  };
});

// ================== SERVER SETUP ================== //

app.use(router.routes());
app.use(router.allowedMethods());

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
