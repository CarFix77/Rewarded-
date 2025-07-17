import { Application, Router } from "https://deno.land/x/oak/mod.ts";

const app = new Application();
const router = new Router();
const kv = await Deno.openKv();

// Конфигурация (критические данные хранятся в памяти)
const CONFIG = {
  adminPassword: "AdGramAdmin777",
  rewardPerAd: 0.0003,
  secretKey: "wagner4625",
  // Лимиты (хранятся в памяти)
  limits: {
    dailyViews: 30,
    minWithdraw: 1.00
  }
};

// Кэш в памяти для часто используемых данных
const memoryCache = {
  users: new Map(), // userId -> { balance, lastRewardDate }
  withdrawals: new Map() // withdrawId -> { userId, amount, status }
};

// Загрузка данных при старте
async function loadCache() {
  for await (const entry of kv.list({ prefix: ["users"] })) {
    memoryCache.users.set(entry.key[1], entry.value);
  }
  console.log(`Loaded ${memoryCache.users.size} users to cache`);
}

// Middleware для CORS
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST");
  await next();
});

// Health check
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "working",
    users: memoryCache.users.size,
    memory: Deno.memoryUsage().rss / 1024 / 1024 + "MB"
  };
});

// Reward endpoint (оптимизированный)
router.get("/reward", async (ctx) => {
  const { userid, key } = ctx.request.url.searchParams;
  
  if (key !== CONFIG.secretKey) {
    ctx.response.status = 403;
    return ctx.response.body = "Invalid key";
  }

  const today = new Date().toISOString().slice(0, 10);
  const user = memoryCache.users.get(userid) || { balance: 0, views: {} };

  // Сброс дневного лимита
  if (user.views.date !== today) {
    user.views = { date: today, count: 0 };
  }

  // Проверка лимита
  if (user.views.count >= CONFIG.limits.dailyViews) {
    ctx.response.status = 429;
    return ctx.response.body = "Daily limit reached";
  }

  // Обновление данных
  user.balance = parseFloat((user.balance + CONFIG.rewardPerAd).toFixed(6));
  user.views.count++;
  user.lastReward = new Date().toISOString();

  // Сохраняем в кэш и асинхронно в KV
  memoryCache.users.set(userid, user);
  kv.set(["users", userid], user).catch(console.error);

  ctx.response.body = {
    success: true,
    balance: user.balance,
    viewsToday: user.views.count
  };
});

// Регистрация (оптимизированная)
router.post("/register", async (ctx) => {
  try {
    const userId = `u${crypto.randomUUID().replace(/-/g, "")}`;
    const userData = { 
      balance: 0, 
      views: { date: "", count: 0 },
      createdAt: new Date().toISOString()
    };
    
    memoryCache.users.set(userId, userData);
    await kv.set(["users", userId], userData);
    
    ctx.response.body = { userId };
  } catch (error) {
    console.error("Registration error:", error);
    ctx.response.status = 500;
    ctx.response.body = "Registration failed";
  }
});

// Вывод средств (с гибридным хранением)
router.post("/withdraw", async (ctx) => {
  try {
    const { userId, amount } = await ctx.request.body().value;
    
    if (amount < CONFIG.limits.minWithdraw) {
      ctx.response.status = 400;
      return ctx.response.body = "Amount too small";
    }

    const user = memoryCache.users.get(userId);
    if (!user || user.balance < amount) {
      ctx.response.status = 400;
      return ctx.response.body = "Insufficient balance";
    }

    // Создаем запрос
    const withdrawId = `w${Date.now()}`;
    const withdrawal = {
      userId,
      amount,
      status: "pending",
      date: new Date().toISOString()
    };

    // Сохраняем только в KV (редко запрашиваемые данные)
    await kv.set(["withdrawals", withdrawId], withdrawal);
    
    // Обновляем баланс в кэше
    user.balance = parseFloat((user.balance - amount).toFixed(6));
    memoryCache.users.set(userId, user);
    
    ctx.response.body = { success: true, withdrawId };
  } catch (error) {
    console.error("Withdrawal error:", error);
    ctx.response.status = 500;
    ctx.response.body = "Withdrawal failed";
  }
});

// Инициализация и запуск
await loadCache();
app.use(router.routes());

const port = 8000;
console.log(`Server started on port ${port}`);
await app.listen({ port });
