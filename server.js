import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";

// Конфиг в одном месте (все константы здесь)
const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "ваш_ключ",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.0,
  REF_PERCENT: 0.15,
  ADMIN_PASS: "ваш_пароль",
  DATA_RETENTION_DAYS: 60 // Хранение данных 60 дней
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// --- Мидлвары ---
app.use(oakCors({ origin: "*" })); // Разрешаем все CORS-запросы
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error(err);
    ctx.response.status = 500;
    ctx.response.body = { ok: false };
  }
});

// --- Фоновые задачи ---
// Автоочистка старых данных (раз в день)
setInterval(async () => {
  const cutoff = Date.now() - CONFIG.DATA_RETENTION_DAYS * 86400000;
  for await (const [key, _] of kv.list({ prefix: ["views"] })) {
    if (new Date(key[2]).getTime() < cutoff) await kv.delete(key);
  }
}, 86400000);

// --- Роуты ---

// Регистрация пользователя
router.post("/register", async (ctx) => {
  const { refCode } = await ctx.request.body().value;
  const userId = `u${Date.now().toString(36)}`;
  const ref = Math.random().toString(36).slice(2, 8);

  await kv.set(["users", userId], {
    b: 0,          // balance
    r: ref,        // refCode
    c: 0,          // refCount
    e: 0,          // refEarnings
    t: Date.now()  // timestamp
  });

  // Начисляем реферальный бонус
  if (refCode) {
    for await (const entry of kv.list({ prefix: ["users"] })) {
      if (entry.value.r === refCode) {
        const bonus = CONFIG.REWARD_PER_AD * CONFIG.REF_PERCENT;
        await kv.set(entry.key, {
          ...entry.value,
          c: entry.value.c + 1,
          e: entry.value.e + bonus,
          b: entry.value.b + bonus
        });
        break;
      }
    }
  }

  ctx.response.body = { 
    ok: true, 
    userId, 
    refCode: ref 
  };
});

// Начисление за просмотр рекламы
router.post("/reward", async (ctx) => {
  const { userId, secret } = await ctx.request.body().value;
  if (secret !== CONFIG.SECRET_KEY) return ctx.response.status = 401;

  const today = new Date().toISOString().slice(0, 10);
  const [user, views] = await Promise.all([
    kv.get(["users", userId]),
    kv.get(["views", userId, today])
  ]);

  if (!user.value || (views.value || 0) >= CONFIG.DAILY_LIMIT) {
    return ctx.response.status = 400;
  }

  const newBalance = user.value.b + CONFIG.REWARD_PER_AD;
  await kv.atomic()
    .set(["users", userId], { ...user.value, b: newBalance })
    .set(["views", userId, today], (views.value || 0) + 1)
    .commit();

  ctx.response.body = { 
    ok: true, 
    balance: newBalance,
    viewsToday: (views.value || 0) + 1
  };
});

// Заявка на вывод средств
router.post("/withdraw", async (ctx) => {
  const { userId, wallet, amount } = await ctx.request.body().value;
  const user = (await kv.get(["users", userId])).value;

  if (!user || !wallet || amount < CONFIG.MIN_WITHDRAW || user.b < amount) {
    return ctx.response.status = 400;
  }

  const wdId = `w${Date.now().toString(36)}`;
  await kv.atomic()
    .set(["users", userId], { ...user, b: user.b - amount })
    .set(["withdrawals", wdId], {
      u: userId,    // user
      a: amount,    // amount
      w: wallet,    // wallet
      d: Date.now(), // date
      s: "pending"  // status
    })
    .commit();

  ctx.response.body = { 
    ok: true, 
    id: wdId 
  };
});

// --- Админ-роуты ---

// Авторизация админа
router.post("/admin/login", async (ctx) => {
  const { password } = await ctx.request.body().value;
  ctx.response.body = { 
    ok: password === CONFIG.ADMIN_PASS,
    token: password === CONFIG.ADMIN_PASS ? "a" + Date.now().toString(36) : null
  };
});

// Получение списка заявок
router.get("/admin/withdrawals", async (ctx) => {
  const withdrawals = [];
  for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
    withdrawals.push({ 
      id: entry.key[1], 
      ...entry.value 
    });
  }
  ctx.response.body = { 
    ok: true, 
    data: withdrawals 
  };
});

// Одобрение заявки (с удалением из базы)
router.post("/admin/withdrawals/:id", async (ctx) => {
  await kv.delete(["withdrawals", ctx.params.id]);
  ctx.response.body = { 
    ok: true 
  };
});

// --- Запуск сервера ---
app.use(router.routes());
app.use(router.allowedMethods());

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`🚀 Server running on port ${port}`);
await app.listen({ port });
