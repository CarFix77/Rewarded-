import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  SECRET_KEY: "wagner46375",
  ADMIN_PASSWORD: "AdGramAdmin777",
  JWT_SECRET: "your_jwt_secret_123"
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

app.use(oakCors({ origin: "*" }));
app.use(router.routes());
app.use(router.allowedMethods());

// Middleware для проверки JWT
const authMiddleware = async (ctx: any, next: any) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Требуется авторизация" };
    return;
  }
  
  const token = authHeader.split(" ")[1];
  try {
    const payload = await verifyJwt(token);
    ctx.state.userId = payload.userId;
    await next();
  } catch {
    ctx.response.status = 403;
    ctx.response.body = { error: "Неверный токен" };
  }
};

// Генерация JWT
async function generateJwt(userId: string): Promise<string> {
  const payload = { userId, exp: Date.now() + 3600000 };
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(CONFIG.JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(JSON.stringify(payload))
  );
  return btoa(JSON.stringify(payload)) + "." + btoa(String.fromCharCode(...new Uint8Array(signature)));
}

// Верификация JWT
async function verifyJwt(token: string): Promise<any> {
  const [headerPayload, signature] = token.split(".");
  const payload = JSON.parse(atob(headerPayload));
  
  if (payload.exp < Date.now()) {
    throw new Error("Token expired");
  }
  
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(CONFIG.JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  
  const isValid = await crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array([...atob(signature)].map(c => c.charCodeAt(0))),
    new TextEncoder().encode(headerPayload)
  );
  
  if (!isValid) throw new Error("Invalid signature");
  return payload;
}

// Регистрация нового пользователя
router.post("/api/register", async (ctx) => {
  const { refCode } = await ctx.request.body().value;
  const userId = `user_${crypto.randomUUID()}`;
  const referralCode = Math.random().toString(36).substring(2, 10).toUpperCase();
  
  await kv.set(["users", userId], {
    balance: 0,
    refCode: referralCode,
    refCount: 0,
    refEarnings: 0,
    completedTasks: []
  });
  
  if (refCode) {
    // Начисляем реферальный бонус
    const referrer = await findUserByRefCode(refCode);
    if (referrer) {
      await kv.set(["users", referrer.userId], {
        ...referrer,
        refCount: (referrer.refCount || 0) + 1
      });
    }
  }
  
  ctx.response.body = { userId, refCode: referralCode };
});

// Получение данных пользователя
router.get("/api/user/:userId", async (ctx) => {
  const user = await kv.get(["users", ctx.params.userId]);
  ctx.response.body = user.value || { error: "User not found" };
});

// Начисление вознаграждения
router.get("/api/reward", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  const key = ctx.request.url.searchParams.get("key");
  
  if (key !== CONFIG.SECRET_KEY) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid key" };
    return;
  }
  
  const today = new Date().toISOString().split("T")[0];
  const [user, dailyStat] = await Promise.all([
    kv.get(["users", userId]),
    kv.get(["stats", userId, today])
  ]);
  
  const viewsToday = dailyStat.value?.views || 0;
  if (viewsToday >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { error: "Daily limit reached" };
    return;
  }
  
  const newBalance = (user.value?.balance || 0) + CONFIG.REWARD_PER_AD;
  await kv.atomic()
    .set(["users", userId], { ...user.value, balance: newBalance })
    .set(["stats", userId, today], { views: viewsToday + 1 })
    .commit();
  
  ctx.response.body = {
    success: true,
    reward: CONFIG.REWARD_PER_AD,
    viewsToday: viewsToday + 1
  };
});

// Вывод средств
router.post("/api/withdraw", async (ctx) => {
  const { userId, wallet, amount } = await ctx.request.body().value;
  const user = await kv.get(["users", userId]);
  
  if (!user.value || user.value.balance < amount) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Недостаточно средств" };
    return;
  }
  
  const withdrawId = crypto.randomUUID();
  await kv.atomic()
    .set(["users", userId], { ...user.value, balance: user.value.balance - amount })
    .set(["withdrawals", withdrawId], {
      userId,
      wallet,
      amount,
      date: new Date().toISOString(),
      status: "pending"
    })
    .commit();
  
  ctx.response.body = { success: true, withdrawId };
});

// Получение заданий
router.get("/api/tasks", async (ctx) => {
  const tasks = [];
  for await (const entry of kv.list({ prefix: ["tasks"] })) {
    tasks.push(entry.value);
  }
  ctx.response.body = tasks;
});

// Завершение задания
router.post("/api/user/:userId/complete-task", async (ctx) => {
  const { taskId } = await ctx.request.body().value;
  const user = await kv.get(["users", ctx.params.userId]);
  const task = await kv.get(["tasks", taskId]);
  
  if (!task.value) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Задание не найдено" };
    return;
  }
  
  const completedTasks = user.value?.completedTasks || [];
  if (completedTasks.includes(taskId)) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Задание уже выполнено" };
    return;
  }
  
  const newBalance = (user.value?.balance || 0) + task.value.reward;
  await kv.set(["users", ctx.params.userId], {
    ...user.value,
    balance: newBalance,
    completedTasks: [...completedTasks, taskId]
  });
  
  ctx.response.body = {
    balance: newBalance,
    completedTasks: [...completedTasks, taskId]
  };
});

// Админ-панель
router.post("/admin/auth", async (ctx) => {
  const { password } = await ctx.request.body().value;
  if (password === CONFIG.ADMIN_PASSWORD) {
    const token = await generateJwt("admin");
    ctx.response.body = { token };
  } else {
    ctx.response.status = 401;
    ctx.response.body = { error: "Неверный пароль" };
  }
});

// Получение заявок на вывод
router.get("/admin/withdrawals", authMiddleware, async (ctx) => {
  const status = ctx.request.url.searchParams.get("status") || "pending";
  const withdrawals = [];
  
  for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
    if (entry.value.status === status) {
      withdrawals.push(entry.value);
    }
  }
  
  ctx.response.body = withdrawals;
});

// Обновление статуса вывода
router.put("/admin/withdrawals/:id", authMiddleware, async (ctx) => {
  const { status } = await ctx.request.body().value;
  const withdrawal = await kv.get(["withdrawals", ctx.params.id]);
  
  if (!withdrawal.value) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Заявка не найдена" };
    return;
  }
  
  await kv.set(["withdrawals", ctx.params.id], {
    ...withdrawal.value,
    status
  });
  
  ctx.response.body = { success: true };
});

// Управление заданиями
router.post("/admin/tasks", authMiddleware, async (ctx) => {
  const { title, reward, description, url, cooldown } = await ctx.request.body().value;
  const taskId = crypto.randomUUID();
  
  await kv.set(["tasks", taskId], {
    id: taskId,
    title,
    reward,
    description,
    url,
    cooldown
  });
  
  ctx.response.body = { id: taskId };
});

router.delete("/admin/tasks/:id", authMiddleware, async (ctx) => {
  await kv.delete(["tasks", ctx.params.id]);
  ctx.response.body = { success: true };
});

// Health check
router.get("/health", (ctx) => {
  ctx.response.body = { status: "OK" };
});

// Поиск пользователя по реферальному коду
async function findUserByRefCode(refCode: string) {
  for await (const entry of kv.list({ prefix: ["users"] })) {
    if (entry.value?.refCode === refCode) {
      return { userId: entry.key[1], ...entry.value };
    }
  }
  return null;
}

await app.listen({ port: 8000 });
