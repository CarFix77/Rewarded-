import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const app = new Application();
const router = new Router();
app.use(oakCors({ origin: "*" }));

// Конфигурация
const CONFIG = {
  SECRET_KEY: "wagner46375", // Ваш секретный ключ
  REWARD_AMOUNT: 0.0003, // Сумма вознаграждения
  DAILY_LIMIT: 30, // Лимит просмотров
  REWARD_URL: "https://test.adsgram.ai/reward?userid=[userId]" // Ваш Reward URL
};

// Хранилище данных (в памяти)
const userData = new Map();

// Обработчик рекламы
router.get("/reward", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  const secret = ctx.request.url.searchParams.get("secret");

  // Проверка секретного ключа
  if (secret !== CONFIG.SECRET_KEY) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid secret key" };
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const userKey = `${userId}_${today}`;

  // Инициализация пользователя
  if (!userData.has(userKey)) {
    userData.set(userKey, {
      views: 0,
      lastReward: null
    });
  }

  const user = userData.get(userKey);

  // Проверка лимита
  if (user.views >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { error: "Daily limit reached" };
    return;
  }

  try {
    // Отправляем запрос на Reward URL
    const rewardUrl = CONFIG.REWARD_URL.replace("[userId]", userId);
    const rewardResponse = await fetch(rewardUrl);

    if (!rewardResponse.ok) {
      throw new Error("Failed to verify reward");
    }

    // Обновляем данные пользователя
    user.views++;
    user.lastReward = new Date().toISOString();

    ctx.response.body = {
      success: true,
      reward: CONFIG.REWARD_AMOUNT,
      viewsToday: user.views,
      balance: (user.views * CONFIG.REWARD_AMOUNT).toFixed(6)
    };

  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { 
      error: "Reward processing failed",
      details: error.message
    };
  }
});

// Статус сервера
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "AdRewards PRO Server",
    endpoints: {
      reward: "/reward?userid=USER_ID&secret=wagner46375"
    }
  };
});

app.use(router.routes());
await app.listen({ port: 8000 });
