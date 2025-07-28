import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";

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

// Улучшенная CORS обработка
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = 204;
    return;
  }
  
  try {
    await next();
  } catch (err) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
    console.error("Error:", err);
  }
});

// Генерация ID
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Регистрация пользователя (исправленная версия)
router.post("/register", async (ctx) => {
  const body = ctx.request.body();
  const { type } = body;
  
  if (type !== "json") {
    ctx.response.status = 400;
    ctx.response.body = { error: "Expected JSON body" };
    return;
  }

  const { refCode } = await body.value;
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

  // Реферальный бонус
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
    refCode: userRefCode
  };
});

// Получение информации о пользователе
router.get("/user/:userId", async (ctx) => {
  const user = (await kv.get(["users", ctx.params.userId])).value;
  
  if (!user) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User not found" };
    return;
  }
  
  ctx.response.body = user;
});

// Награда за просмотр
router.get("/reward", async (ctx) => {
  const params = ctx.request.url.searchParams;
  const userId = params.get("userid");
  const secret = params.get("secret");

  if (secret !== CONFIG.SECRET_KEY) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid secret key" };
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const user = (await kv.get(["users", userId])).value || { balance: 0 };
  const dailyViews = (await kv.get(["views", userId, today])).value || 0;

  if (dailyViews >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 400;
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
    balance: newBalance,
    viewsToday: dailyViews + 1
  };
});

// Вывод средств
router.post("/withdraw", async (ctx) => {
  const { userId, wallet, amount } = await ctx.request.body().value;
  const user = (await kv.get(["users", userId])).value;

  if (!user) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User not found" };
    return;
  }

  if (amount < CONFIG.MIN_WITHDRAW || amount > user.balance) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Invalid amount" };
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

// Админ-панель
router.post("/admin/login", async (ctx) => {
  const { password } = await ctx.request.body().value;
  
  if (password === CONFIG.ADMIN_PASSWORD) {
    ctx.response.body = { 
      success: true,
      token: `admin_${generateId()}`
    };
  } else {
    ctx.response.status = 401;
    ctx.response.body = { error: "Wrong password" };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
