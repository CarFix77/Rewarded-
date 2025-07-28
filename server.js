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
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
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
    ctx.response.body = { error: "Invalid request" };
  }
});

// Эндпоинт регистрации (POST)
router.post("/register", async (ctx) => {
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
      refCode: userRefCode
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Registration failed" };
  }
});

// Тестовый GET для проверки работы
router.get("/register", (ctx) => {
  ctx.response.body = { 
    message: "Use POST method to register",
    example: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { refCode: "optional_referral_code" }
    }
  };
});

// Health check
router.get("/health", (ctx) => {
  ctx.response.body = { status: "OK", timestamp: new Date().toISOString() };
});

app.use(router.routes());
app.use(router.allowedMethods());

// Обработка 404
app.use((ctx) => {
  ctx.response.status = 404;
  ctx.response.body = { error: "Endpoint not found" };
});

const port = parseInt(Deno.env.get("PORT") || 8000;
console.log(`Server running on port ${port}`);
await app.listen({ port });
