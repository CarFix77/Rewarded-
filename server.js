import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223"
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Настройка CORS
app.use(oakCors({ origin: "*" }));

// Генерация ID
function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

// Регистрация пользователя
router.post("/register", async (ctx) => {
  const { refCode } = await ctx.request.body().value;
  const userId = `user_${generateId()}`;
  const userRefCode = generateId().toUpperCase();

  await kv.set(["users", userId], {
    balance: 0,
    refCode: userRefCode,
    refCount: 0,
    refEarnings: 0
  });

  // Начисление реферального бонуса
  if (refCode) {
    for await (const entry of kv.list({ prefix: ["users"] })) {
      if (entry.value.refCode === refCode) {
        const bonus = CONFIG.REWARD_PER_AD * CONFIG.REFERRAL_PERCENT;
        await kv.set(entry.key, {
          ...entry.value,
          refCount: entry.value.refCount + 1,
          refEarnings: entry.value.refEarnings + bonus,
          balance: entry.value.balance + bonus
        });
        break;
      }
    }
  }

  ctx.response.body = {
    userId,
    refCode: userRefCode,
    refLink: `${ctx.request.url.origin}?ref=${userRefCode}`
  };
});

// Начисление вознаграждения
router.get("/reward", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  const secret = ctx.request.url.searchParams.get("secret");

  if (secret !== CONFIG.SECRET_KEY) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid secret" };
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const user = (await kv.get(["users", userId])).value || { balance: 0 };
  const dailyViews = (await kv.get(["views", userId, today])).value || 0;

  if (dailyViews >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { error: "Daily limit reached" };
    return;
  }

  const newBalance = user.balance + CONFIG.REWARD_PER_AD;
  await kv.atomic()
    .set(["users", userId], { ...user, balance: newBalance })
    .set(["views", userId, today], dailyViews + 1)
    .commit();

  ctx.response.body = {
    success: true,
    reward: CONFIG.REWARD_PER_AD,
    balance: newBalance,
    viewsToday: dailyViews + 1
  };
});

// Вывод средств
router.post("/withdraw", async (ctx) => {
  const { userId, wallet, amount } = await ctx.request.body().value;
  const user = (await kv.get(["users", userId])).value;

  if (!user || user.balance < amount || amount < CONFIG.MIN_WITHDRAW) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Invalid withdrawal" };
    return;
  }

  const withdrawId = `wd_${generateId()}`;
  await kv.atomic()
    .set(["users", userId], { ...user, balance: user.balance - amount })
    .set(["withdrawals", withdrawId], {
      userId,
      amount,
      wallet,
      date: new Date().toISOString(),
      status: "pending"
    })
    .commit();

  ctx.response.body = { success: true, withdrawId };
});

// Админ-панель
router.post("/admin/login", async (ctx) => {
  const { password } = await ctx.request.body().value;
  if (password === CONFIG.ADMIN_PASSWORD) {
    ctx.response.body = { success: true, token: "admin_" + generateId() };
  } else {
    ctx.response.status = 401;
    ctx.response.body = { error: "Wrong password" };
  }
});

router.get("/admin/withdrawals", async (ctx) => {
  const withdrawals = [];
  for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
    withdrawals.push(entry.value);
  }
  ctx.response.body = withdrawals;
});

router.post("/admin/withdrawals/:id", async (ctx) => {
  const { status } = await ctx.request.body().value;
  const withdrawal = (await kv.get(["withdrawals", ctx.params.id])).value;

  if (!withdrawal) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Not found" };
    return;
  }

  await kv.set(["withdrawals", ctx.params.id], {
    ...withdrawal,
    status,
    processedAt: new Date().toISOString()
  });

  ctx.response.body = { success: true };
});

// Статус сервера
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "OK",
    endpoints: {
      register: "POST /register",
      reward: "/reward?userid=USERID&secret=wagner46375",
      withdraw: "POST /withdraw",
      admin: "/admin/login"
    }
  };
});

app.use(router.routes());
await app.listen({ port: 8000 });
