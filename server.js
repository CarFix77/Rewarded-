import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

app.use(oakCors({ origin: "*" }));

// Объект с функциями для генерации ключей
const DATA_KEYS = {
  BALANCE: (userId) => ["balance", userId],
  DAILY_VIEWS: (userId, date) => ["daily", userId, date],
  REFERRALS: (userId) => ["refs", userId],
  COMPLETED_TASKS: (userId) => ["tasks", userId],
  WITHDRAWALS: (userId) => ["withdrawals", userId]
};

// Начисление вознаграждения
router.get("/reward", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  const secret = ctx.request.url.searchParams.get("secret");

  if (secret !== CONFIG.SECRET_KEY) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid secret key" };
    return;
  }

  if (!userId || !/^\d+$/.test(userId)) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Invalid user ID" };
    return;
  }

  try {
    const today = new Date().toISOString().split("T")[0];
    const dailyViews = (await kv.get(DATA_KEYS.DAILY_VIEWS(userId, today))).value || 0;

    if (dailyViews >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 429;
      ctx.response.body = { error: "Daily limit reached" };
      return;
    }

    await kv.atomic()
      .sum(DATA_KEYS.BALANCE(userId), CONFIG.REWARD_PER_AD)
      .set(DATA_KEYS.DAILY_VIEWS(userId, today), dailyViews + 1)
      .commit();

    ctx.response.body = {
      success: true,
      reward: CONFIG.REWARD_PER_AD,
      viewsToday: dailyViews + 1,
      balance: (await kv.get(DATA_KEYS.BALANCE(userId))).value || 0
    };

  } catch (error) {
    console.error("Error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Вывод средств
router.post("/withdraw", async (ctx) => {
  const body = await ctx.request.body().value;
  const userId = body.userId;
  const wallet = body.wallet;

  const balance = (await kv.get(DATA_KEYS.BALANCE(userId))).value || 0;

  if (balance < CONFIG.MIN_WITHDRAW) {
    ctx.response.status = 400;
    ctx.response.body = { error: `Minimum withdraw: $${CONFIG.MIN_WITHDRAW}` };
    return;
  }

  try {
    const withdrawId = crypto.randomUUID();
    await kv.set([...DATA_KEYS.WITHDRAWALS(userId), withdrawId], {
      amount: balance,
      wallet,
      date: new Date().toISOString()
    });

    // Очищаем данные, кроме рефералов
    await cleanUserData(userId, { preserveReferrals: true });

    ctx.response.body = { 
      success: true,
      amount: balance
    };

  } catch (error) {
    console.error("Withdraw error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Withdrawal failed" };
  }
});

// Функция очистки данных
async function cleanUserData(userId, options) {
  const today = new Date().toISOString().split("T")[0];
  const dailyKeys = [];
  
  for await (const entry of kv.list({ prefix: DATA_KEYS.DAILY_VIEWS(userId, "") })) {
    if (!entry.key[2].includes(today)) {
      dailyKeys.push(entry.key);
    }
  }

  const atomic = kv.atomic()
    .delete(DATA_KEYS.BALANCE(userId))
    .delete(DATA_KEYS.COMPLETED_TASKS(userId));

  dailyKeys.forEach(key => atomic.delete(key));

  if (!options.preserveReferrals) {
    atomic.delete(DATA_KEYS.REFERRALS(userId));
  }

  await atomic.commit();
}

// Статус сервера
router.get("/", (ctx) => {
  ctx.response.body = { 
    status: "OK",
    endpoints: {
      reward: "/reward?userid=[USERID]&secret=wagner46375",
      withdraw: "POST /withdraw {userId, wallet}"
    }
  };
});

app.use(router.routes());
await app.listen({ port: 8000 });
