import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const app = new Application();
const router = new Router();
app.use(oakCors({ origin: "*" }));

// Конфиг
const CONFIG = {
  REWARD_URL: "https://test.adsgram.ai/reward?userid=[userId]", // Ваш внешний URL
  SECRET: "wagner46375",
  REWARD_AMOUNT: 0.0003,
  DAILY_LIMIT: 30
};

const adViews = new Map(); // Хранилище просмотров

// Обработка рекламы
router.get("/reward", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  const secret = ctx.request.url.searchParams.get("secret");

  // Проверка ключа
  if (secret !== CONFIG.SECRET) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid secret" };
    return;
  }

  // Проверка лимита
  const today = new Date().toISOString().split("T")[0];
  const key = `${userId}_${today}`;
  const todayViews = adViews.get(key) || 0;

  if (todayViews >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { error: "Daily limit reached" };
    return;
  }

  // Отправляем запрос на внешний Reward URL
  try {
    const rewardUrl = CONFIG.REWARD_URL.replace("[userId]", userId);
    const rewardResponse = await fetch(rewardUrl);
    
    if (!rewardResponse.ok) {
      throw new Error("Ошибка внешнего Reward URL");
    }

    // Записываем просмотр
    adViews.set(key, todayViews + 1);
    
    ctx.response.body = {
      success: true,
      reward: CONFIG.REWARD_AMOUNT,
      viewsToday: todayViews + 1
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Reward service error" };
  }
});

app.use(router.routes());
await app.listen({ port: 8000 });
console.log("Сервер запущен: http://localhost:8000");
