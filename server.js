import { Application, Router } from "https://deno.land/x/oak/mod.ts";

const app = new Application();
const router = new Router();
const kv = await Deno.openKv();

// Конфигурация
const CONFIG = {
  secretKey: "wagner4625",   // Секретный ключ для API
  rewardAmount: 0.0003,      // Награда за 1 просмотр
  dailyLimit: 30             // Лимит начислений/день
};

// Типы данных
interface User {
  userId: string;
  balance: number;
  lastRewardDate: string;
  todayViews: number;
}

// Reward endpoint
router.get("/reward", async (ctx) => {
  const params = ctx.request.url.searchParams;
  const userId = params.get("userid");
  const key = params.get("key");

  // 1. Проверка параметров
  if (!userId || !key) {
    ctx.response.status = 400;
    return ctx.response.body = { 
      success: false, 
      error: "Нужны параметры: userid и key" 
    };
  }

  // 2. Проверка секретного ключа
  if (key !== CONFIG.secretKey) {
    ctx.response.status = 401;
    return ctx.response.body = { 
      success: false, 
      error: "Неверный ключ" 
    };
  }

  const today = new Date().toISOString().split("T")[0]; // Формат: YYYY-MM-DD
  const userKey = ["users", userId];

  // 3. Получаем/создаем данные пользователя
  let user = (await kv.get<User>(userKey)).value;
  if (!user) {
    user = {
      userId,
      balance: 0,
      lastRewardDate: today,
      todayViews: 0
    };
  }

  // 4. Сброс счетчика, если дата изменилась
  if (user.lastRewardDate !== today) {
    user.todayViews = 0;
    user.lastRewardDate = today;
  }

  // 5. Проверка дневного лимита
  if (user.todayViews >= CONFIG.dailyLimit) {
    ctx.response.status = 429;
    return ctx.response.body = { 
      success: false, 
      error: `Лимит ${CONFIG.dailyLimit} просмотров/день исчерпан` 
    };
  }

  // 6. Начисление награды
  user.balance = parseFloat((user.balance + CONFIG.rewardAmount).toFixed(6));
  user.todayViews++;

  // 7. Сохраняем данные
  await kv.set(userKey, user);

  // 8. Успешный ответ
  ctx.response.body = {
    success: true,
    userId,
    reward: CONFIG.rewardAmount,
    balance: user.balance,
    viewsToday: user.todayViews,
    viewsRemaining: CONFIG.dailyLimit - user.todayViews
  };
});

// Статистика (для админа)
router.get("/stats", async (ctx) => {
  const totalUsers = await countUsers();
  ctx.response.body = {
    totalUsers,
    rewardAmount: CONFIG.rewardAmount,
    dailyLimit: CONFIG.dailyLimit
  };
});

// Вспомогательные функции
async function countUsers(): Promise<number> {
  const iter = kv.list({ prefix: ["users"] });
  let count = 0;
  for await (const _ of iter) count++;
  return count;
}

// Запуск сервера
app.use(router.routes());
app.use(router.allowedMethods());

console.log("🚀 Сервер запущен: http://localhost:8000");
await app.listen({ port: 8000 });
