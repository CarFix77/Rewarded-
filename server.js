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

// CORS Middleware
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  await next();
});

function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Основные endpoint'ы
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "online",
    message: "AdRewards PRO Server",
    endpoints: [
      "POST /register - Регистрация",
      "GET /reward?userid=ID&secret=KEY - Награда за просмотр",
      "POST /withdraw - Вывод средств",
      "POST /admin/login - Аутентификация админа"
    ]
  };
});

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

    ctx.response.body = { userId, refCode: userRefCode };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Registration failed" };
  }
});

router.get("/reward", async (ctx) => {
  try {
    const userId = ctx.request.url.searchParams.get("userid");
    const secret = ctx.request.url.searchParams.get("secret");

    if (secret !== CONFIG.SECRET_KEY) {
      ctx.response.status = 401;
      ctx.response.body = { error: "Invalid secret" };
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

    ctx.response.body = { balance: newBalance, viewsToday: dailyViews + 1 };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Reward processing failed" };
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

    ctx.response.body = { withdrawId };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Withdrawal failed" };
  }
});

// Админ-панель
router.post("/admin/login", async (ctx) => {
  try {
    const { password } = await ctx.request.body().value;
    
    if (password === CONFIG.ADMIN_PASSWORD) {
      ctx.response.body = { token: `admin_${generateId()}` };
    } else {
      ctx.response.status = 401;
      ctx.response.body = { error: "Wrong password" };
    }
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Login failed" };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
