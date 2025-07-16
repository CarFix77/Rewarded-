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
  keepWithdrawals: 3,
  cleanupAfterDays: 7,
  rewardUrl: "https://carfix77-rewarded-71.deno.dev/reward?userid=[userId]&key=wagner4625"
};

// Helpers
const compressUser = (user) => ({
  b: user.balance,
  rc: user.refCode,
  r: user.refCount || 0,
  re: user.refEarnings || 0,
  ct: user.completedTasks || [],
  v: user.todayViews || 0,
  l: user.lastRewardDate
});

const decompressUser = (data) => ({
  balance: data.b,
  refCode: data.rc,
  refCount: data.r,
  refEarnings: data.re,
  completedTasks: data.ct,
  todayViews: data.v,
  lastRewardDate: data.l
});

// Очистка данных пользователя
async function cleanupUser(userId: string) {
  const userEntry = await kv.get(["u", userId]);
  if (!userEntry.value) return;

  const user = decompressUser(userEntry.value);
  
  await kv.set(["u", userId], compressUser({
    ...user,
    todayViews: 0,
    lastRewardDate: ""
  }));

  const withdrawals = [];
  for await (const entry of kv.list({ prefix: ["w", userId] })) {
    withdrawals.push(entry);
  }
  
  if (withdrawals.length > CONFIG.keepWithdrawals) {
    withdrawals
      .sort((a, b) => b.value[0] - a.value[0])
      .slice(CONFIG.keepWithdrawals)
      .forEach(async entry => await kv.delete(entry.key));
  }
}

// API Endpoints

// Регистрация
router.post("/api/register", async (ctx) => {
  try {
    const { refCode } = await ctx.request.body().value;
    const userId = `u${crypto.randomUUID().replace(/-/g, "")}`;
    
    const userData = compressUser({
      balance: 0,
      refCode: Math.random().toString(36).substring(2, 10).toUpperCase(),
      lastRewardDate: new Date().toISOString().split('T')[0],
      todayViews: 0
    });

    await kv.set(["u", userId], userData);

    if (refCode) {
      for await (const entry of kv.list({ prefix: ["u"] })) {
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
      refCode: userData.rc
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Registration failed" };
  }
});

// Просмотр рекламы (ревард-эндпоинт)
router.get("/reward", async (ctx) => {
  const params = ctx.request.url.searchParams;
  const userId = params.get("userid");
  const key = params.get("key");

  if (!userId || key !== CONFIG.secretKey) {
    ctx.response.status = 400;
    return ctx.response.body = { error: "Invalid request" };
  }

  const today = new Date().toISOString().split('T')[0];
  const userEntry = await kv.get(["u", userId]);
  
  if (!userEntry.value) {
    ctx.response.status = 404;
    return ctx.response.body = { error: "User not found" };
  }

  let user = decompressUser(userEntry.value);

  if (user.lastRewardDate === "") {
    user.lastRewardDate = today;
    user.todayViews = 0;
  }

  if (user.todayViews >= CONFIG.dailyLimit) {
    return ctx.response.body = { 
      success: false, 
      message: "Daily limit reached" 
    };
  }

  user.balance += CONFIG.rewardPerAd;
  user.todayViews++;
  user.lastRewardDate = today;

  await kv.set(["u", userId], compressUser(user));

  ctx.response.body = {
    success: true,
    reward: CONFIG.rewardPerAd,
    balance: user.balance,
    viewsToday: user.todayViews
  };
});

// Вывод средств
router.post("/api/withdraw", async (ctx) => {
  try {
    const { userId, wallet, amount } = await ctx.request.body().value;
    
    if (!userId || !/^P\d{7,}$/.test(wallet) || amount < CONFIG.minWithdraw) {
      ctx.response.status = 400;
      return ctx.response.body = { error: "Invalid request" };
    }

    const userEntry = await kv.get(["u", userId]);
    if (!userEntry.value) {
      ctx.response.status = 404;
      return ctx.response.body = { error: "User not found" };
    }

    const user = decompressUser(userEntry.value);
    
    if (user.balance < amount) {
      ctx.response.status = 400;
      return ctx.response.body = { error: "Insufficient balance" };
    }

    const withdrawId = `w${Date.now()}`;
    await kv.set(["w", userId, withdrawId], [
      Date.now(),
      Math.round(amount * 100),
      wallet.substring(0, 8),
      "pending"
    ]);

    user.balance -= amount;
    await kv.set(["u", userId], compressUser(user));

    await cleanupUser(userId);

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

// Данные пользователя
router.get("/api/user/:id", async (ctx) => {
  const userEntry = await kv.get(["u", ctx.params.id]);
  if (!userEntry.value) {
    ctx.response.status = 404;
    return ctx.response.body = { error: "User not found" };
  }

  const user = decompressUser(userEntry.value);
  
  let withdrawalsCount = 0;
  for await (const _ of kv.list({ prefix: ["w", ctx.params.id] })) {
    withdrawalsCount++;
  }

  ctx.response.body = {
    ...user,
    withdrawalsCount,
    isDataOptimized: user.lastRewardDate === ""
  };
});

// Статистика за день
router.get("/api/stats/:userId/:date", async (ctx) => {
  const userEntry = await kv.get(["u", ctx.params.userId]);
  if (!userEntry.value) {
    ctx.response.status = 404;
    return ctx.response.body = { error: "User not found" };
  }

  const user = decompressUser(userEntry.value);
  
  ctx.response.body = {
    views: user.lastRewardDate === ctx.params.date ? user.todayViews : 0
  };
});

// Задания
router.get("/api/tasks", async (ctx) => {
  const tasks = [];
  for await (const entry of kv.list({ prefix: ["tasks"] })) {
    tasks.push({
      id: entry.key[1],
      title: entry.value.title,
      reward: entry.value.reward,
      description: entry.value.description,
      url: entry.value.url,
      cooldown: entry.value.cooldown || 10
    });
  }
  ctx.response.body = tasks;
});

// Завершение задания
router.post("/api/user/:userId/complete-task", async (ctx) => {
  try {
    const { taskId } = await ctx.request.body().value;
    const userKey = ["u", ctx.params.userId];
    const taskKey = ["tasks", taskId];
    
    const [userEntry, taskEntry] = await Promise.all([
      kv.get(userKey),
      kv.get(taskKey)
    ]);
    
    if (!userEntry.value || !taskEntry.value) {
      ctx.response.status = 404;
      return ctx.response.body = { error: "Not found" };
    }
    
    const user = decompressUser(userEntry.value);
    
    if (user.completedTasks.includes(taskId)) {
      ctx.response.status = 400;
      return ctx.response.body = { error: "Task already completed" };
    }
    
    user.balance += taskEntry.value.reward;
    user.completedTasks = [...user.completedTasks, taskId];
    
    await kv.set(userKey, compressUser(user));
    
    ctx.response.body = {
      success: true,
      balance: user.balance,
      completedTasks: user.completedTasks
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to complete task" };
  }
});

// Админ-панель
router.post("/admin/auth", async (ctx) => {
  const { password } = await ctx.request.body().value;
  
  if (password === CONFIG.adminPassword) {
    const token = crypto.randomUUID();
    await kv.set(["admin_token", token], { valid: true });
    ctx.response.body = { success: true, token };
  } else {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid password" };
  }
});

// Заявки на вывод
router.get("/admin/withdrawals", async (ctx) => {
  const token = ctx.request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) {
    ctx.response.status = 401;
    return ctx.response.body = { error: "Unauthorized" };
  }

  const tokenEntry = await kv.get(["admin_token", token]);
  if (!tokenEntry.value) {
    ctx.response.status = 401;
    return ctx.response.body = { error: "Invalid token" };
  }

  const status = ctx.request.url.searchParams.get("status") || "pending";
  const withdrawals = [];

  for await (const entry of kv.list({ prefix: ["w"] })) {
    if (entry.value[3] === status) {
      withdrawals.push({
        id: entry.key[2],
        userId: entry.key[1],
        date: new Date(entry.value[0]).toISOString(),
        amount: entry.value[1] / 100,
        wallet: `P${entry.value[2]}`,
        status: entry.value[3]
      });
    }
  }

  ctx.response.body = withdrawals.sort((a, b) => new Date(b.date) - new Date(a.date));
});

// Обработка заявки
router.put("/admin/withdrawals/:id", async (ctx) => {
  const token = ctx.request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) {
    ctx.response.status = 401;
    return ctx.response.body = { error: "Unauthorized" };
  }

  const tokenEntry = await kv.get(["admin_token", token]);
  if (!tokenEntry.value) {
    ctx.response.status = 401;
    return ctx.response.body = { error: "Invalid token" };
  }

  const { status } = await ctx.request.body().value;
  if (!["completed", "rejected"].includes(status)) {
    ctx.response.status = 400;
    return ctx.response.body = { error: "Invalid status" };
  }

  let found = false;
  for await (const entry of kv.list({ prefix: ["w"] })) {
    if (entry.key[2] === ctx.params.id) {
      const updatedValue = [...entry.value];
      updatedValue[3] = status;
      await kv.set(entry.key, updatedValue);
      found = true;
      break;
    }
  }

  if (!found) {
    ctx.response.status = 404;
    return ctx.response.body = { error: "Withdrawal not found" };
  }

  ctx.response.body = { success: true };
});

// Управление заданиями
router.get("/admin/tasks", async (ctx) => {
  const token = ctx.request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) {
    ctx.response.status = 401;
    return ctx.response.body = { error: "Unauthorized" };
  }

  const tokenEntry = await kv.get(["admin_token", token]);
  if (!tokenEntry.value) {
    ctx.response.status = 401;
    return ctx.response.body = { error: "Invalid token" };
  }

  const tasks = [];
  for await (const entry of kv.list({ prefix: ["tasks"] })) {
    tasks.push({
      id: entry.key[1],
      ...entry.value
    });
  }
  ctx.response.body = tasks;
});

router.post("/admin/tasks", async (ctx) => {
  const token = ctx.request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) {
    ctx.response.status = 401;
    return ctx.response.body = { error: "Unauthorized" };
  }

  const tokenEntry = await kv.get(["admin_token", token]);
  if (!tokenEntry.value) {
    ctx.response.status = 401;
    return ctx.response.body = { error: "Invalid token" };
  }

  const { title, reward, description, url, cooldown } = await ctx.request.body().value;
  if (!title || !reward || !description || !url) {
    ctx.response.status = 400;
    return ctx.response.body = { error: "Missing required fields" };
  }

  const taskId = crypto.randomUUID();
  await kv.set(["tasks", taskId], {
    title,
    reward: parseFloat(reward),
    description,
    url,
    cooldown: parseInt(cooldown) || 10
  });

  ctx.response.body = {
    success: true,
    taskId
  };
});

router.delete("/admin/tasks/:id", async (ctx) => {
  const token = ctx.request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) {
    ctx.response.status = 401;
    return ctx.response.body = { error: "Unauthorized" };
  }

  const tokenEntry = await kv.get(["admin_token", token]);
  if (!tokenEntry.value) {
    ctx.response.status = 401;
    return ctx.response.body = { error: "Invalid token" };
  }

  await kv.delete(["tasks", ctx.params.id]);
  ctx.response.body = { success: true };
});

// Health check
router.get("/health", (ctx) => {
  ctx.response.body = { status: "ok" };
});

// Запуск сервера
app.use(oakCors());
app.use(router.routes());
app.use(router.allowedMethods());

console.log("🚀 Server ready on http://localhost:8000");
await app.listen({ port: 8000 });
