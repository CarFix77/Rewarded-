// Импорты
import { Application, Router } from "https://deno.land/x/oak/mod.ts";

// Конфигурация
const CONFIG = {
  SECRET_KEY: "Jora1513", // Ваш API-ключ
  REWARD_AMOUNT: 0.0003, // $ за просмотр
  REF_PERCENT: 0.15, // 15% реферальных
  MIN_WITHDRAW: 1.00, // Минимальный вывод
  ADMIN_PASSWORD: "AdGramAdmin777" // Пароль админки
};

// Инициализация KV-базы
const kv = await Deno.openKv();

// Сервер
const app = new Application();
const router = new Router();

// Middleware для проверки ключа API
router.use(async (ctx, next) => {
  const key = ctx.request.url.searchParams.get("key");
  if (key !== CONFIG.SECRET_KEY && !ctx.request.url.pathname.startsWith("/admin")) {
    ctx.response.status = 403;
    ctx.response.body = { error: "Invalid API key" };
    return;
  }
  await next();
});

// Reward URL для AdGram
router.get("/reward", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  if (!userId) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Missing userid" };
    return;
  }

  // Атомарное обновление баланса
  const userKey = ["users", userId];
  const result = await kv.atomic()
    .set(["total_requests"], (await kv.get(["total_requests"])).value + 1 || 1)
    .mutate({
      key: userKey,
      type: "sum",
      value: { balance: CONFIG.REWARD_AMOUNT }
    })
    .commit();

  if (!result.ok) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to update balance" };
    return;
  }

  // Реферальное начисление
  const refId = ctx.request.url.searchParams.get("ref");
  if (refId && refId !== userId) {
    const refReward = CONFIG.REWARD_AMOUNT * CONFIG.REF_PERCENT;
    await kv.atomic()
      .mutate({
        key: ["users", refId],
        type: "sum",
        value: { 
          balance: refReward,
          ref_earnings: refReward,
          referrals: 1
        }
      })
      .commit();
  }

  // Возвращаем текущий баланс
  const user = await kv.get(userKey);
  ctx.response.body = {
    success: true,
    balance: user.value?.balance || 0
  };
});

// Вывод средств
router.post("/withdraw", async (ctx) => {
  const { userId, amount, wallet } = await ctx.request.body().value;

  if (!userId || !amount || !wallet) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Missing data" };
    return;
  }

  // Проверка минимальной суммы
  if (amount < CONFIG.MIN_WITHDRAW) {
    ctx.response.status = 400;
    ctx.response.body = { error: `Minimum withdraw is $${CONFIG.MIN_WITHDRAW}` };
    return;
  }

  // Атомарная проверка баланса и списание
  const userKey = ["users", userId];
  const withdrawalId = crypto.randomUUID();

  const result = await kv.atomic()
    .check(await kv.get(userKey)) // Проверяем актуальность данных
    .mutate({
      key: userKey,
      type: "checkAndSet",
      value: { balance: -amount },
      threshold: amount // Проверяет, что баланс >= amount
    })
    .set(["withdrawals", withdrawalId], {
      userId,
      amount,
      wallet,
      status: "pending",
      createdAt: new Date().toISOString()
    })
    .commit();

  if (!result.ok) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Insufficient balance" };
    return;
  }

  ctx.response.body = { success: true, withdrawalId };
});

// Админ-панель
router.get("/admin", async (ctx) => {
  if (ctx.request.url.searchParams.get("password") !== CONFIG.ADMIN_PASSWORD) {
    ctx.response.status = 403;
    ctx.response.body = "Access denied";
    return;
  }

  // Собираем статистику
  const [
    usersCount,
    totalBalance,
    recentWithdrawals
  ] = await Promise.all([
    Array.fromAsync(kv.list({ prefix: ["users"] })).then(arr => arr.length),
    Array.fromAsync(kv.list({ prefix: ["users"] }))
      .then(users => users.reduce((sum, user) => sum + (user.value.balance || 0), 0)),
    Array.fromAsync(kv.list({ prefix: ["withdrawals"] }, { limit: 20, reverse: true }))
  ]);

  // Генерация HTML
  ctx.response.body = `
    <h1>AdGram Admin</h1>
    <p>Total users: ${usersCount}</p>
    <p>Total balance: $${totalBalance.toFixed(4)}</p>
    
    <h2>Recent withdrawals</h2>
    <ul>
      ${recentWithdrawals.map(w => `
        <li>
          ${w.value.userId} → $${w.value.amount} 
          (${w.value.wallet})<br>
          <small>${w.value.createdAt} • ${w.value.status}</small>
        </li>
      `).join("")}
    </ul>
  `;
});

// Проверка баланса
router.get("/balance", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  if (!userId) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Missing userid" };
    return;
  }

  const user = await kv.get(["users", userId]);
  ctx.response.body = {
    success: true,
    balance: user.value?.balance || 0,
    referrals: user.value?.referrals || 0,
    ref_earnings: user.value?.ref_earnings || 0
  };
});

app.use(router.routes());
await app.listen({ port: 8000 });
