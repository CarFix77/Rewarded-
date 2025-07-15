import { Application, Router, send } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const app = new Application();
const router = new Router();
const kv = await Deno.openKv();

// Конфигурация
const CONFIG = {
  secretKey: "wagner4625",
  rewardAmount: 0.0003,
  dailyLimit: 30
};

// Middleware для CORS
app.use(oakCors());

// API Endpoints
router.get("/api/reward", async (ctx) => {
  const params = ctx.request.url.searchParams;
  const userId = params.get("userid");
  const key = params.get("key");

  if (!userId || !key) {
    ctx.response.status = 400;
    return ctx.response.body = { error: "Missing parameters" };
  }

  if (key !== CONFIG.secretKey) {
    ctx.response.status = 401;
    return ctx.response.body = { error: "Invalid key" };
  }

  const today = new Date().toISOString().split("T")[0];
  const userKey = ["users", userId];

  let user = (await kv.get(userKey)).value || {
    userId,
    balance: 0,
    lastRewardDate: today,
    todayViews: 0
  };

  if (user.lastRewardDate !== today) {
    user.todayViews = 0;
    user.lastRewardDate = today;
  }

  if (user.todayViews >= CONFIG.dailyLimit) {
    ctx.response.status = 429;
    return ctx.response.body = { error: "Daily limit reached" };
  }

  user.balance = parseFloat((user.balance + CONFIG.rewardAmount).toFixed(6));
  user.todayViews++;

  await kv.set(userKey, user);

  ctx.response.body = {
    success: true,
    reward: CONFIG.rewardAmount,
    balance: user.balance,
    viewsToday: user.todayViews
  };
});

// Статический фронтенд
router.get("/", async (ctx) => {
  await send(ctx, ctx.request.url.pathname, {
    root: `${Deno.cwd()}/static`,
    index: "index.html",
  });
});

app.use(router.routes());
app.use(router.allowedMethods());

// Обработка 404
app.use((ctx) => {
  ctx.response.status = 404;
  ctx.response.body = "Not Found";
});

console.log("Server running on http://localhost:8000");
await app.listen({ port: 8000 });
