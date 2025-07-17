import { Application, Router } from "https://deno.land/x/oak/mod.ts";

const app = new Application();
const router = new Router();

// Минимальная конфигурация
const CONFIG = {
  rewardPerAd: 0.0003,
  secretKey: "wagner4625"
};

// Простейшее хранилище в памяти
const users = new Map();

// Middleware для логов (обязательно)
app.use(async (ctx, next) => {
  console.log(`${new Date().toISOString()} ${ctx.request.method} ${ctx.request.url.pathname}`);
  await next();
});

// Корневой эндпоинт
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "working",
    users: users.size,
    memory: `${(Deno.memoryUsage().rss / 1024 / 1024).toFixed(2)}MB`
  };
});

// Reward endpoint
router.get("/reward", (ctx) => {
  const { userid, key } = ctx.request.url.searchParams;
  
  // Валидация
  if (key !== CONFIG.secretKey) {
    ctx.response.status = 403;
    ctx.response.body = "Invalid key";
    return;
  }

  // Получаем или создаем пользователя
  if (!users.has(userid)) {
    users.set(userid, { balance: 0 });
  }

  const user = users.get(userid);
  user.balance += CONFIG.rewardPerAd;

  ctx.response.body = {
    success: true,
    balance: user.balance.toFixed(6),
    reward: CONFIG.rewardPerAd
  };
});

// Регистрация
router.post("/register", (ctx) => {
  const userId = `user_${Date.now()}`;
  users.set(userId, { balance: 0 });
  ctx.response.body = { userId };
});

app.use(router.routes());

// Запуск сервера с обработкой ошибок
const port = 8000;
console.log(`Starting server on port ${port}...`);

try {
  await app.listen({ port });
  console.log("Server successfully started!");
} catch (error) {
  console.error("Failed to start server:", error);
}
