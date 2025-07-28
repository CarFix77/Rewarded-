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

// Настройка CORS
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Middleware для парсинга JSON
app.use(async (ctx, next) => {
  try {
    if (ctx.request.hasBody) {
      const body = ctx.request.body();
      if (body.type === "json") {
        ctx.state.body = await body.value;
      }
    }
    await next();
  } catch (err) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Invalid request", details: err.message };
  }
});

// Эндпоинты API

// [GET] Проверка здоровья сервера
router.get("/api/health", (ctx) => {
  ctx.response.body = { 
    status: "OK",
    version: "1.0",
    timestamp: new Date().toISOString()
  };
});

// [POST] Регистрация пользователя
router.post("/api/register", async (ctx) => {
  try {
    const { refCode } = ctx.state.body || {};
    
    const userId = `user_${Date.now()}`;
    const userRefCode = `ref_${Math.floor(100000 + Math.random() * 900000)}`;
    
    const userData = {
      userId,
      balance: 0,
      refCode: userRefCode,
      refCount: 0,
      refEarnings: 0,
      createdAt: new Date().toISOString()
    };

    await kv.set(["users", userId], userData);

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
    ctx.response.body = { 
      error: "Registration failed",
      details: error.message 
    };
  }
});

// [GET] Получение информации о пользователе
router.get("/api/user/:userId", async (ctx) => {
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

// Подключение роутера
app.use(router.routes());
app.use(router.allowedMethods());

// Обработка 404 (должна быть после всех роутов)
app.use((ctx) => {
  ctx.response.status = 404;
  ctx.response.body = { 
    error: "Endpoint not found",
    availableEndpoints: [
      "GET /api/health",
      "POST /api/register",
      "GET /api/user/:userId"
    ]
  };
});

// Запуск сервера
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
