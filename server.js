import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// CORS Middleware
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  await next();
});

// Генерация ID
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Проверка работы сервера
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "online",
    message: "AdRewards PRO Server",
    endpoints: [
      "POST /register - Регистрация нового пользователя",
      "GET /reward?userid=ID&secret=KEY - Получить награду за просмотр",
      "GET /user/:userId - Информация о пользователе"
    ]
  };
});

// Регистрация пользователя
router.post("/register", async (ctx) => {
  try {
    const body = ctx.request.body();
    const { value } = body;
    const { refCode } = await value;
    
    const userId = `user_${generateId()}`;
    const userRefCode = generateId().toString();

    await kv.set(["users", userId], {
      balance: 0,
      refCode: userRefCode,
      refCount: 0,
      refEarnings: 0,
      createdAt: new Date().toISOString()
    });

    // Реферальная система
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
      refCode: userRefCode,
      balance: 0
    };

  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Registration failed" };
  }
});

// Получение информации о пользователе
router.get("/user/:userId", async (ctx) => {
  try {
    const user = (await kv.get(["users", ctx.params.userId])).value;
    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }
    ctx.response.body = user;
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Server error" };
  }
});

// Награда за просмотр
router.get("/reward", async (ctx) => {
  try {
    const params = ctx.request.url.searchParams;
    const userId = params.get("userid");
    const secret = params.get("secret");

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

    ctx.response.body = {
      success: true,
      balance: newBalance,
      viewsToday: dailyViews + 1
    };

  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Reward processing failed" };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
