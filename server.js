import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  WEBHOOK_SECRET: "wagner1080",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223"
};

// Открываем KV-хранилище
const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Настройка CORS
app.use(oakCors({ origin: "*" }));
app.use(router.routes());
app.use(router.allowedMethods());

// Middleware для статических файлов
app.use(async (ctx) => {
  try {
    await ctx.send({
      root: `${Deno.cwd()}/public`,
      index: "index.html",
    });
  } catch {
    ctx.response.status = 404;
    ctx.response.body = "Not Found";
  }
});

// Генерация ID
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// API Endpoints
router.post("/api/register", async (ctx) => {
  const { refCode } = await ctx.request.body().value;
  const userId = `user_${generateId()}`;
  const userRefCode = generateId().toString();

  await kv.set(["users", userId], {
    balance: 0,
    refCode: userRefCode,
    refCount: 0,
    refEarnings: 0,
    createdAt: new Date().toISOString()
  });

  // Реферальный бонус
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

router.get("/api/reward", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  const secret = ctx.request.url.searchParams.get("secret");

  if (secret !== CONFIG.SECRET_KEY && secret !== CONFIG.WEBHOOK_SECRET) {
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

// Запуск сервера
console.log("Server running on http://localhost:8000");
await app.listen({ port: 8000 });
