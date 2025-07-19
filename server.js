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

// Ключи для хранения данных
const DATA_KEYS = {
  BALANCE: (userId: string) => ["balance", userId],
  DAILY_VIEWS: (userId: string, date: string) => ["daily", userId, date],
  REFERRALS: (userId: string) => ["refs", userId],
  COMPLETED_TASKS: (userId: string) => ["tasks", userId],
  WITHDRAWALS: (userId: string) => ["withdrawals", userId]
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

    // Атомарное обновление данных
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

// Вывод средств с очисткой данных
router.post("/withdraw", async (ctx) => {
  const { userId, wallet } = await ctx.request.body().value;
  const balanceKey = DATA_KEYS.BALANCE(userId);
  const balance = (await kv.get(balanceKey)).value || 0;

  if (balance < CONFIG.MIN_WITHDRAW) {
    ctx.response.status = 400;
    ctx.response.body = { error: `Minimum withdraw: $${CONFIG.MIN_WITHDRAW}` };
    return;
  }

  try {
    // Сохраняем рефералов перед очисткой
    const referrals = (await kv.get(DATA_KEYS.REFERRALS(userId))).value || [];
    
    // Создаем запись о выводе
    const withdrawId = crypto.randomUUID();
    await kv.set([...DATA_KEYS.WITHDRAWALS(userId), withdrawId], {
      amount: balance,
      wallet,
      date: new Date().toISOString()
    });

    // Очищаем все данные, кроме рефералов и истории выводов
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

// Функция очистки данных пользователя
async function cleanUserData(userId: string, options: { preserveReferrals: boolean }) {
  const today = new Date().toISOString().split("T")[0];
  
  // Удаляем ежедневную статистику (кроме сегодняшней)
  const dailyKeys = [];
  for await (const entry of kv.list({ prefix: DATA_KEYS.DAILY_VIEWS(userId, "") })) {
    if (!entry.key.includes(today)) {
      dailyKeys.push(entry.key);
    }
  }

  // Формируем атомарную операцию
  const atomic = kv.atomic()
    .delete(DATA_KEYS.BALANCE(userId))
    .delete(DATA_KEYS.COMPLETED_TASKS(userId));

  // Удаляем старую статистику
  dailyKeys.forEach(key => atomic.delete(key));

  // Сохраняем рефералов если нужно
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
