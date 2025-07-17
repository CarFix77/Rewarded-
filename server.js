import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375", // Ваш секретный ключ
  DAILY_LIMIT: 30
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Настройка CORS
app.use(oakCors({ origin: "*" }));

// Обработчик для callback от рекламной сети
router.get("/reward", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  const secret = ctx.request.url.searchParams.get("secret");

  // Валидация ключа
  if (secret !== CONFIG.SECRET_KEY) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid secret key" };
    return;
  }

  // Проверка userid
  if (!userId || !/^\d+$/.test(userId)) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Invalid user ID" };
    return;
  }

  try {
    const today = new Date().toISOString().split("T")[0];
    const dailyKey = ["daily", userId, today];

    // Проверка дневного лимита
    const dailyViews = (await kv.get(dailyKey)).value || 0;
    if (dailyViews >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 429;
      ctx.response.body = { error: "Daily limit reached" };
      return;
    }

    // Начисление вознаграждения
    await kv.atomic()
      .sum(["balance", userId], CONFIG.REWARD_PER_AD)
      .set(dailyKey, dailyViews + 1)
      .commit();

    ctx.response.body = {
      success: true,
      userId,
      reward: CONFIG.REWARD_PER_AD,
      balance: (await kv.get(["balance", userId])).value || 0,
      viewsToday: dailyViews + 1
    };

  } catch (error) {
    console.error("Error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Статус сервера
router.get("/", (ctx) => {
  ctx.response.body = { 
    status: "OK",
    reward_endpoint: "/reward?userid=[USERID]&secret=wagner46375"
  };
});

app.use(router.routes());
await app.listen({ port: 8000 });
