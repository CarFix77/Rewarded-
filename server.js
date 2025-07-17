import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  REWARD_SECRET: "AdRewardsSecure123"
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Настройка CORS
app.use(oakCors({ origin: "*" }));

// Reward Endpoint (Главный эндпоинт для рекламы)
router.get("/reward", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  const secret = ctx.request.url.searchParams.get("secret");

  // Валидация
  if (!userId || secret !== CONFIG.REWARD_SECRET) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Invalid parameters" };
    return;
  }

  try {
    const today = new Date().toISOString().split("T")[0];
    const [user, dailyViews] = await Promise.all([
      kv.get(["users", userId]),
      kv.get(["stats", userId, today])
    ]);

    // Проверка лимитов
    const viewsToday = dailyViews.value?.views || 0;
    if (viewsToday >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 429;
      ctx.response.body = { error: "Daily limit reached" };
      return;
    }

    // Начисление
    const reward = CONFIG.REWARD_PER_AD;
    await kv.atomic()
      .sum(["users", userId, "balance"], reward)
      .set(["stats", userId, today], { views: viewsToday + 1 })
      .commit();

    ctx.response.body = {
      success: true,
      userId,
      reward,
      viewsToday: viewsToday + 1
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Reward processing failed" };
  }
});

// Дополнительные эндпоинты
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "OK",
    app: "AdRewards+",
    reward_url: "/reward?userid=[USER_ID]&secret=AdRewardsSecure123"
  };
});

app.use(router.routes());

// Запуск сервера
const port = 8000;
console.log(`Server running on port ${port}`);
await app.listen({ port });
