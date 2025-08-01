import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  WEBHOOK_SECRET: "wagner1080",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223"
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// 1. CORS middleware (должен быть первым)
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// 2. Логирование запросов
app.use(async (ctx, next) => {
  console.log(`[${new Date().toISOString()}] ${ctx.request.method} ${ctx.request.url.pathname}`);
  await next();
});

// 3. Парсинг JSON (исправленная версия)
app.use(async (ctx, next) => {
  try {
    if (ctx.request.hasBody) {
      const body = ctx.request.body();
      if (body.type === "json") {
        ctx.state.body = await body.value;
      } else if (body.type === "form-data") {
        const formData = await body.value.read();
        ctx.state.body = formData.fields;
      }
    }
    await next();
  } catch (err) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid request body" };
  }
});

// Генерация ID
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Проверка авторизации администратора
async function checkAdminAuth(ctx, next) {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }
  await next();
}

// Основные маршруты
router
  .get("/", (ctx) => {
    ctx.response.body = {
      success: true,
      status: "OK",
      version: "1.0",
      endpoints: {
        register: "POST /register",
        reward: "/reward?userid=USERID&secret=wagner46375",
        withdraw: "POST /withdraw",
        tasks: "GET /tasks"
      }
    };
  })
  .post("/register", async (ctx) => {
    try {
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

      await kv.set(["users", userId], userData);

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
        refLink: `https://t.me/Ad_Rew_ards_bot?start=${userRefCode}`
      };
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = { 
        success: false,
        error: "Registration failed",
        details: error.message 
      };
    }
  })
  .get("/reward", async (ctx) => {
    try {
      const userId = ctx.request.url.searchParams.get("userid");
      const secret = ctx.request.url.searchParams.get("secret");

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

      const user = (await kv.get(["users", userId])).value;
      if (!user) {
        ctx.response.status = 404;
        ctx.response.body = { success: false, error: "User not found" };
        return;
      }

      const today = new Date().toISOString().split("T")[0];
      const dailyViews = (await kv.get(["views", userId, today])).value || 0;

      if (dailyViews >= CONFIG.DAILY_LIMIT) {
        ctx.response.status = 429;
        ctx.response.body = { success: false, error: "Daily limit reached" };
        return;
      }

      const newBalance = user.balance + CONFIG.REWARD_PER_AD;
      await kv.atomic()
        .set(["users", userId], { ...user, balance: newBalance })
        .set(["views", userId, today], dailyViews + 1)
        .commit();

      ctx.response.body = {
        success: true,
        reward: CONFIG.REWARD_PER_AD,
        balance: newBalance,
        viewsToday: dailyViews + 1
      };
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = { 
        success: false,
        error: "Failed to process reward",
        details: error.message 
      };
    }
  })
  .post("/withdraw", async (ctx) => {
    try {
      const { userId, wallet, amount } = ctx.state.body || {};
      const user = (await kv.get(["users", userId])).value;

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
      ctx.response.status = 500;
      ctx.response.body = { 
        success: false,
        error: "Withdrawal failed",
        details: error.message 
      };
    }
  })
  .get("/user/:userId", async (ctx) => {
    try {
      const userId = ctx.params.userId;
      const user = (await kv.get(["users", userId])).value;
      
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
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = { 
        success: false,
        error: "Failed to get user",
        details: error.message 
      };
    }
  });

// Админ-маршруты
const adminRouter = new Router();
adminRouter
  .post("/login", async (ctx) => {
    try {
      const { password } = ctx.state.body || {};
      if (password === CONFIG.ADMIN_PASSWORD) {
        ctx.response.body = { 
          success: true, 
          token: "admin_" + generateId() 
        };
      } else {
        ctx.response.status = 401;
        ctx.response.body = { success: false, error: "Wrong password" };
      }
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = { 
        success: false,
        error: "Login failed",
        details: error.message 
      };
    }
  })
  .get("/withdrawals", checkAdminAuth, async (ctx) => {
    try {
      const withdrawals = [];
      for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
        withdrawals.push(entry.value);
      }
      ctx.response.body = { success: true, withdrawals };
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = { 
        success: false,
        error: "Failed to get withdrawals",
        details: error.message 
      };
    }
  });

// Подключаем все роутеры
app.use(router.routes());
app.use(adminRouter.routes());
app.use(router.allowedMethods());

// Обработка 404
app.use((ctx) => {
  ctx.response.status = 404;
  ctx.response.body = { success: false, error: "Endpoint not found" };
});

// Запуск сервера
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
