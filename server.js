import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const app = new Application();
const router = new Router();
const kv = await Deno.openKv();

// Конфигурация
const CONFIG = {
  adminPassword: "AdGramAdmin777",
  rewardPerAd: 0.0003,
  dailyLimit: 30,
  minWithdraw: 1.00,
  referralPercent: 0.15,
  secretKey: "wagner4625",
  rewardUrl: "https://your-server.deno.dev/reward?userid=[userId]&key=wagner4625"
};

// Helper функции
const compressUser = (user) => ({
  b: user.balance,
  rc: user.refCode,
  r: user.refCount || 0,
  re: user.refEarnings || 0,
  ct: user.completedTasks || [],
  v: user.todayViews || 0,
  l: user.lastRewardDate || "",
  w: user.wallet || ""
});

const decompressUser = (data) => ({
  balance: data.b,
  refCode: data.rc,
  refCount: data.r,
  refEarnings: data.re,
  completedTasks: data.ct,
  todayViews: data.v,
  lastRewardDate: data.l,
  wallet: data.w
});

// Middleware
app.use(oakCors());
app.use(router.routes());
app.use(router.allowedMethods());

// ==================== Основные API эндпоинты ====================

// Reward endpoint для рекламных сетей
router.get("/reward", async (ctx) => {
  const params = ctx.request.url.searchParams;
  const userId = params.get("userid");
  const key = params.get("key");

  // Валидация
  if (!userId || key !== CONFIG.secretKey) {
    ctx.response.status = 400;
    return ctx.response.body = { error: "Invalid request" };
  }

  try {
    const userEntry = await kv.get(["users", userId]);
    if (!userEntry.value) {
      ctx.response.status = 404;
      return ctx.response.body = { error: "User not found" };
    }

    const user = decompressUser(userEntry.value);
    const today = new Date().toISOString().split('T')[0];

    // Сброс счетчика если новый день
    if (user.lastRewardDate !== today) {
      user.todayViews = 0;
      user.lastRewardDate = today;
    }

    // Проверка лимита
    if (user.todayViews >= CONFIG.dailyLimit) {
      ctx.response.status = 429;
      return ctx.response.body = { 
        error: "Daily limit reached",
        limit: CONFIG.dailyLimit
      };
    }

    // Начисление награды
    user.balance = parseFloat((user.balance + CONFIG.rewardPerAd).toFixed(6));
    user.todayViews++;

    await kv.set(["users", userId], compressUser(user));

    ctx.response.body = {
      success: true,
      reward: CONFIG.rewardPerAd,
      balance: user.balance,
      viewsToday: user.todayViews,
      viewsRemaining: CONFIG.dailyLimit - user.todayViews
    };

  } catch (error) {
    console.error("Reward processing error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Регистрация пользователя
router.post("/api/register", async (ctx) => {
  try {
    const { refCode } = await ctx.request.body().value;
    const userId = `u${crypto.randomUUID().replace(/-/g, "")}`;
    const refCodeNew = Math.random().toString(36).substring(2, 10).toUpperCase();

    const userData = compressUser({
      balance: 0,
      refCode: refCodeNew,
      lastRewardDate: "",
      todayViews: 0
    });

    await kv.set(["users", userId], userData);

    // Реферальная логика
    if (refCode) {
      for await (const entry of kv.list({ prefix: ["users"] })) {
        if (entry.value.rc === refCode) {
          const referrer = decompressUser(entry.value);
          referrer.r += 1;
          await kv.set(entry.key, compressUser(referrer));
          break;
        }
      }
    }

    ctx.response.body = {
      success: true,
      userId,
      refCode: refCodeNew,
      rewardUrl: CONFIG.rewardUrl.replace("[userId]", userId)
    };

  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Registration failed" };
  }
});

// Вывод средств
router.post("/api/withdraw", async (ctx) => {
  try {
    const { userId, wallet, amount } = await ctx.request.body().value;
    
    // Валидация
    if (!userId || !/^P\d{7,}$/.test(wallet)) {
      ctx.response.status = 400;
      return ctx.response.body = { error: "Invalid wallet format" };
    }

    if (isNaN(amount) || amount < CONFIG.minWithdraw) {
      ctx.response.status = 400;
      return ctx.response.body = { error: `Minimum amount is $${CONFIG.minWithdraw}` };
    }

    const userEntry = await kv.get(["users", userId]);
    if (!userEntry.value) {
      ctx.response.status = 404;
      return ctx.response.body = { error: "User not found" };
    }

    const user = decompressUser(userEntry.value);
    
    if (user.balance < amount) {
      ctx.response.status = 400;
      return ctx.response.body = { error: "Insufficient balance" };
    }

    // Создание заявки
    const withdrawId = `wd${Date.now()}`;
    await kv.set(["withdrawals", withdrawId], {
      userId,
      amount: parseFloat(amount.toFixed(2)),
      wallet,
      status: "pending",
      date: new Date().toISOString()
    });

    // Обновление баланса
    user.balance = parseFloat((user.balance - amount).toFixed(6));
    user.wallet = wallet; // Сохраняем кошелек
    await kv.set(["users", userId], compressUser(user));

    ctx.response.body = {
      success: true,
      withdrawId,
      newBalance: user.balance
    };

  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Withdrawal failed" };
  }
});

// Получение данных пользователя
router.get("/api/user/:id", async (ctx) => {
  try {
    const userEntry = await kv.get(["users", ctx.params.id]);
    if (!userEntry.value) {
      ctx.response.status = 404;
      return ctx.response.body = { error: "User not found" };
    }

    const user = decompressUser(userEntry.value);

    // Получаем историю выводов
    const withdrawals = [];
    for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
      if (entry.value.userId === ctx.params.id) {
        withdrawals.push(entry.value);
      }
    }

    ctx.response.body = {
      ...user,
      withdrawals,
      rewardUrl: CONFIG.rewardUrl.replace("[userId]", ctx.params.id)
    };

  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Server error" };
  }
});

// ==================== Админ-панель ====================

// Аутентификация админа
router.post("/admin/auth", async (ctx) => {
  const { password } = await ctx.request.body().value;
  
  if (password === CONFIG.adminPassword) {
    const token = crypto.randomUUID();
    await kv.set(["admin_tokens", token], { 
      valid: true,
      createdAt: new Date().toISOString() 
    });
    
    ctx.response.body = { 
      success: true,
      token 
    };
  } else {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid password" };
  }
});

// Middleware для проверки админ-токена
async function adminAuthMiddleware(ctx, next) {
  const token = ctx.request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Token required" };
    return;
  }

  const tokenEntry = await kv.get(["admin_tokens", token]);
  if (!tokenEntry.value?.valid) {
    ctx.response.status = 403;
    ctx.response.body = { error: "Invalid token" };
    return;
  }

  await next();
}

// Управление заявками на вывод
router.get("/admin/withdrawals", adminAuthMiddleware, async (ctx) => {
  const status = ctx.request.url.searchParams.get("status") || "pending";
  const withdrawals = [];

  for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
    if (entry.value.status === status) {
      withdrawals.push(entry.value);
    }
  }

  ctx.response.body = withdrawals.sort((a, b) => 
    new Date(b.date) - new Date(a.date)
  );
});

router.put("/admin/withdrawals/:id", adminAuthMiddleware, async (ctx) => {
  const { status } = await ctx.request.body().value;
  
  if (!["completed", "rejected"].includes(status)) {
    ctx.response.status = 400;
    return ctx.response.body = { error: "Invalid status" };
  }

  const entry = await kv.get(["withdrawals", ctx.params.id]);
  if (!entry.value) {
    ctx.response.status = 404;
    return ctx.response.body = { error: "Not found" };
  }

  await kv.set(["withdrawals", ctx.params.id], {
    ...entry.value,
    status
  });

  ctx.response.body = { success: true };
});

// Управление заданиями
router.get("/admin/tasks", adminAuthMiddleware, async (ctx) => {
  const tasks = [];
  for await (const entry of kv.list({ prefix: ["tasks"] })) {
    tasks.push({
      id: entry.key[1],
      ...entry.value
    });
  }
  ctx.response.body = tasks;
});

router.post("/admin/tasks", adminAuthMiddleware, async (ctx) => {
  const { title, reward, description, url, cooldown } = await ctx.request.body().value;
  
  if (!title || !reward || !description || !url) {
    ctx.response.status = 400;
    return ctx.response.body = { error: "Missing fields" };
  }

  const taskId = crypto.randomUUID();
  await kv.set(["tasks", taskId], {
    title,
    reward: parseFloat(reward),
    description,
    url,
    cooldown: cooldown ? parseInt(cooldown) : 10
  });

  ctx.response.body = {
    success: true,
    taskId
  };
});

router.delete("/admin/tasks/:id", adminAuthMiddleware, async (ctx) => {
  await kv.delete(["tasks", ctx.params.id]);
  ctx.response.body = { success: true };
});

// Health check
router.get("/health", (ctx) => {
  ctx.response.body = { 
    status: "ok",
    version: "1.0",
    uptime: process.uptime() 
  };
});

// Запуск сервера
console.log("🚀 Server running on http://localhost:8000");
await app.listen({ port: 8000 });
