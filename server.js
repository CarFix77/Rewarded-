import { Application, Router } from "https://deno.land/x/oak/mod.ts";

const app = new Application();
const router = new Router();
const kv = await Deno.openKv();

// Минимальная конфигурация в памяти
const CONFIG = {
  rewardPerAd: 0.0003,
  secretKey: "wagner4625",
  dailyLimit: 30
};

// Простейший кэш для активных пользователей
const activeUsers = new Map();

// Middleware для базовой логики
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  await next();
});

// Health check с реальными данными
router.get("/", async (ctx) => {
  let userCount = 0;
  for await (const _ of kv.list({ prefix: ["users"] })) userCount++;
  
  ctx.response.body = {
    status: "working",
    users: userCount,
    activeUsers: activeUsers.size,
    memory: `${(Deno.memoryUsage().rss / 1024 / 1024).toFixed(2)}MB`
  };
});

// Reward endpoint с гибридным кэшированием
router.get("/reward", async (ctx) => {
  const { userid, key } = ctx.request.url.searchParams;
  
  // Базовая валидация
  if (!userid || key !== CONFIG.secretKey) {
    ctx.response.status = 400;
    return ctx.response.body = { error: "invalid_request" };
  }

  try {
    // Пытаемся получить из кэша
    let user = activeUsers.get(userid);
    const today = new Date().toISOString().slice(0, 10);
    
    // Если нет в кэше - загружаем из KV
    if (!user) {
      const kvUser = await kv.get(["users", userid]);
      user = kvUser.value || {
        balance: 0,
        views: { date: today, count: 0 }
      };
      activeUsers.set(userid, user);
    }

    // Проверка дневного лимита
    if (user.views.date !== today) {
      user.views = { date: today, count: 0 };
    } else if (user.views.count >= CONFIG.dailyLimit) {
      ctx.response.status = 429;
      return ctx.response.body = { error: "daily_limit_reached" };
    }

    // Обновление баланса
    user.balance = parseFloat((user.balance + CONFIG.rewardPerAd).toFixed(6));
    user.views.count++;
    
    // Асинхронное сохранение
    kv.set(["users", userid], user).catch(console.error);

    ctx.response.body = {
      success: true,
      balance: user.balance,
      views_today: user.views.count
    };

  } catch (error) {
    console.error("Reward error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "server_error" };
  }
});

// Упрощенная регистрация
router.post("/register", async (ctx) => {
  try {
    const userId = `u${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const userData = {
      balance: 0,
      views: { date: "", count: 0 },
      created_at: new Date().toISOString()
    };
    
    await kv.set(["users", userId], userData);
    ctx.response.body = { user_id: userId };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "registration_failed" };
  }
});

// Запуск сервера
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server started on port ${port}`);
await app.listen({ port });
