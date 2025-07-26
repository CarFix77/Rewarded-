import { Application, Router, send } from "https://deno.land/x/oak/mod.ts";
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
  return Math.floor(100000 + Math.random() * 900000);
}

// API Endpoints
router.post("/api/register", async (ctx) => {
  try {
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
      success: true,
      userId,
      refCode: userRefCode,
      refLink: `${ctx.request.url.origin}?ref=${userRefCode}`
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

router.get("/api/reward", async (ctx) => {
  try {
    const userId = ctx.request.url.searchParams.get("userid");
    const secret = ctx.request.url.searchParams.get("secret");

    if (!userId || !secret) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing parameters" };
      return;
    }

    if (secret !== CONFIG.SECRET_KEY) {
      ctx.response.status = 401;
      ctx.response.body = { error: "Invalid secret" };
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    const user = (await kv.get(["users", userId])).value;
    const dailyViews = (await kv.get(["views", userId, today])).value || 0;

    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }

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
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Статические файлы (фронтенд)
router.get("/(.*)", async (ctx) => {
  try {
    await send(ctx, ctx.request.url.pathname, {
      root: `${Deno.cwd()}/public`,
      index: "index.html",
    });
  } catch {
    ctx.response.status = 404;
    ctx.response.body = "Not Found";
  }
});

// Подключение роутов
app.use(router.routes());
app.use(router.allowedMethods());

console.log("Server running on http://localhost:8000");
await app.listen({ port: 8000 });
