import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.8/firebase-app.js";
import { getDatabase, ref, set, get, update, remove, push, query, equalTo, orderByChild } from "https://www.gstatic.com/firebasejs/9.6.8/firebase-database.js";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  WEBHOOK_SECRET: "wagner1080",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223"
};

// Инициализация Firebase
const firebaseConfig = {
  databaseURL: "https://ggggitz-default-rtdb.firebaseio.com/"
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

const app = new Application();
const router = new Router();

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

function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

async function getData(path) {
  const snapshot = await get(ref(db, path));
  return snapshot.exists() ? snapshot.val() : null;
}

async function setData(path, data) {
  await set(ref(db, path), data);
}

async function updateData(path, updates) {
  await update(ref(db, path), updates);
}

// ================== ROUTES ================== //

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

  await setData(`users/${userId}`, userData);

  if (refCode) {
    const usersSnapshot = await get(ref(db, 'users'));
    if (usersSnapshot.exists()) {
      const users = usersSnapshot.val();
      const referrer = Object.values(users).find(u => u.refCode === refCode);
      
      if (referrer) {
        const bonus = CONFIG.REWARD_PER_AD * CONFIG.REFERRAL_PERCENT;
        await updateData(`users/${Object.keys(users).find(key => users[key] === referrer)}`, {
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

  const user = await getData(`users/${userId}`);
  if (!user) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "User not found" };
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const dailyViews = await getData(`views/${userId}/${today}`) || 0;

  if (dailyViews >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { success: false, error: "Daily limit reached" };
    return;
  }

  const newBalance = user.balance + CONFIG.REWARD_PER_AD;
  await updateData(`users/${userId}`, { balance: newBalance });
  await setData(`views/${userId}/${today}`, dailyViews + 1);

  ctx.response.body = {
    success: true,
    reward: CONFIG.REWARD_PER_AD,
    balance: newBalance,
    viewsToday: dailyViews + 1
  };
});

router.get("/user/:userId", async (ctx) => {
  const userId = ctx.params.userId;
  const user = await getData(`users/${userId}`);
  
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

router.get("/views/:userId/:date", async (ctx) => {
  const { userId, date } = ctx.params;
  const views = await getData(`views/${userId}/${date}`) || 0;
  ctx.response.body = { success: true, views };
});

router.post("/withdraw", async (ctx) => {
  const { userId, wallet, amount } = ctx.state.body || {};
  const user = await getData(`users/${userId}`);

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
  await updateData(`users/${userId}`, { balance: user.balance - amount });
  
  const withdrawalData = {
    userId,
    amount,
    wallet,
    date: new Date().toISOString(),
    status: "pending"
  };
  
  await setData(`withdrawals/${withdrawId}`, withdrawalData);

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

  const withdrawals = await getData('withdrawals') || {};
  ctx.response.body = { 
    success: true, 
    withdrawals: Object.entries(withdrawals).map(([id, data]) => ({ id, ...data })) 
  };
});

router.post("/admin/withdrawals/:id", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  const { status } = ctx.state.body || {};
  const withdrawal = await getData(`withdrawals/${ctx.params.id}`);

  if (!withdrawal) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Not found" };
    return;
  }

  await updateData(`withdrawals/${ctx.params.id}`, {
    ...withdrawal,
    status,
    processedAt: new Date().toISOString()
  });

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
      tasks: "GET /tasks"
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
