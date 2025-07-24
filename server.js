import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223" // Пароль для админки
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

app.use(oakCors({ origin: "*" }));
app.use(router.routes());

// Генерация реферального кода
function generateRefCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Регистрация пользователя с реферальной системой
router.post("/register", async (ctx) => {
  const { refCode } = await ctx.request.body().value;
  const userId = `user_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const userRefCode = generateRefCode();

  // Сохраняем нового пользователя
  await kv.set(["users", userId], {
    balance: 0,
    refCode: userRefCode,
    refCount: 0,
    refEarnings: 0,
    createdAt: new Date().toISOString(),
    withdrawals: []
  });

  // Если есть реферальный код, начисляем бонус
  if (refCode) {
    const referrer = await findUserByRefCode(refCode);
    if (referrer) {
      const bonus = CONFIG.REWARD_PER_AD * CONFIG.REFERRAL_PERCENT;
      await kv.set(["users", referrer.userId], {
        ...referrer,
        refCount: referrer.refCount + 1,
        refEarnings: referrer.refEarnings + bonus,
        balance: referrer.balance + bonus
      });
    }
  }

  ctx.response.body = { 
    success: true,
    userId,
    refCode: userRefCode,
    refLink: `${ctx.request.url.origin}?ref=${userRefCode}`
  };
});

// Начисление вознаграждения
router.get("/reward", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  const secret = ctx.request.url.searchParams.get("secret");

  // Валидация
  if (secret !== CONFIG.SECRET_KEY) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid secret key" };
    return;
  }

  if (!userId) {
    ctx.response.status = 400;
    ctx.response.body = { error: "User ID required" };
    return;
  }

  try {
    const today = new Date().toISOString().split("T")[0];
    const user = (await kv.get(["users", userId])).value;
    const dailyViews = (await kv.get(["stats", userId, today])).value || 0;

    // Проверка лимита
    if (dailyViews >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 429;
      ctx.response.body = { error: "Daily limit reached" };
      return;
    }

    // Начисление
    const newBalance = user.balance + CONFIG.REWARD_PER_AD;
    await kv.atomic()
      .set(["users", userId], { ...user, balance: newBalance })
      .set(["stats", userId, today], dailyViews + 1)
      .commit();

    ctx.response.body = {
      success: true,
      reward: CONFIG.REWARD_PER_AD,
      balance: newBalance,
      viewsToday: dailyViews + 1
    };

  } catch (error) {
    console.error("Reward error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Вывод средств
router.post("/withdraw", async (ctx) => {
  const { userId, wallet, amount } = await ctx.request.body().value;
  const user = (await kv.get(["users", userId])).value;

  // Валидация
  if (!user || !wallet || !amount) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Invalid data" };
    return;
  }

  if (amount < CONFIG.MIN_WITHDRAW) {
    ctx.response.status = 400;
    ctx.response.body = { error: `Minimum withdraw: $${CONFIG.MIN_WITHDRAW}` };
    return;
  }

  if (user.balance < amount) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Insufficient balance" };
    return;
  }

  // Создаем заявку на вывод
  const withdrawId = crypto.randomUUID();
  const withdrawal = {
    id: withdrawId,
    userId,
    wallet,
    amount,
    date: new Date().toISOString(),
    status: "pending"
  };

  await kv.atomic()
    .set(["users", userId], { ...user, balance: user.balance - amount })
    .set(["withdrawals", withdrawId], withdrawal)
    .commit();

  ctx.response.body = { 
    success: true,
    withdrawId,
    newBalance: user.balance - amount
  };
});

// Админ-панель
router.post("/admin/login", async (ctx) => {
  const { password } = await ctx.request.body().value;
  if (password === CONFIG.ADMIN_PASSWORD) {
    ctx.response.body = { success: true, token: "admin_auth_token" };
  } else {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid password" };
  }
});

// Получение списка заявок на вывод
router.get("/admin/withdrawals", async (ctx) => {
  const withdrawals = [];
  for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
    withdrawals.push(entry.value);
  }
  ctx.response.body = withdrawals;
});

// Обработка вывода (одобрение/отклонение)
router.post("/admin/withdrawals/:id", async (ctx) => {
  const { status } = await ctx.request.body().value;
  const withdrawId = ctx.params.id;
  const withdrawal = (await kv.get(["withdrawals", withdrawId])).value;

  if (!withdrawal) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Withdrawal not found" };
    return;
  }

  // Обновляем статус
  await kv.set(["withdrawals", withdrawId], {
    ...withdrawal,
    status,
    processedAt: new Date().toISOString()
  });

  // Если отклоняем - возвращаем средства
  if (status === "rejected") {
    const user = (await kv.get(["users", withdrawal.userId])).value;
    await kv.set(["users", withdrawal.userId], {
      ...user,
      balance: user.balance + withdrawal.amount
    });
  }

  ctx.response.body = { success: true };
});

// Статистика для админки
router.get("/admin/stats", async (ctx) => {
  const stats = {
    totalUsers: 0,
    totalWithdrawals: 0,
    pendingWithdrawals: 0
  };

  // Считаем пользователей
  for await (const _ of kv.list({ prefix: ["users"] })) {
    stats.totalUsers++;
  }

  // Считаем выводы
  for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
    stats.totalWithdrawals++;
    if (entry.value.status === "pending") stats.pendingWithdrawals++;
  }

  ctx.response.body = stats;
});

// Вспомогательные функции
async function findUserByRefCode(refCode) {
  for await (const entry of kv.list({ prefix: ["users"] })) {
    if (entry.value.refCode === refCode) {
      return { userId: entry.key[1], ...entry.value };
    }
  }
  return null;
}

// Старт сервера
console.log("Server running on http://localhost:8000");
await app.listen({ port: 8000 });
