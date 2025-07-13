import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";
import { create, verify } from "https://deno.land/x/djwt@v2.8/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  SECRET_KEY: "Jora1514"
};

const PORT = 8000;
const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

app.use(oakCors({ origin: "*" }));

// Генерация JWT
async function generateToken(userId: string) {
  return await create(
    { alg: "HS256" },
    { userId, exp: Date.now() + 86400000 },
    CONFIG.SECRET_KEY
  );
}

// Регистрация
router.post("/api/register", async (ctx) => {
  const { refCode } = await ctx.request.body().value;
  const userId = `user_${crypto.randomUUID()}`;
  const userRefCode = Math.random().toString(36).substring(2, 8).toUpperCase();

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
        await kv.set(["refs", refCode, userId], { date: new Date().toISOString() });
        await kv.set(["users", entry.key[1], "refCount"], entry.value.refCount + 1);
        break;
      }
    }
  }

  const token = await generateToken(userId);
  ctx.response.body = { userId, refCode: userRefCode, token };
});

// Просмотр рекламы
router.post("/api/watch-ad", async (ctx) => {
  const { userId } = await ctx.request.body().value;
  const today = new Date().toISOString().split("T")[0];
  
  const [user, dailyViews] = await Promise.all([
    kv.get(["users", userId]),
    kv.get(["stats", userId, today])
  ]);

  if (!user.value) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User not found" };
    return;
  }

  const viewsToday = dailyViews.value?.views || 0;
  if (viewsToday >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Daily limit reached" };
    return;
  }

  const reward = CONFIG.REWARD_PER_AD;
  let refRewards = 0;

  for await (const entry of kv.list({ prefix: ["refs", userId] })) {
    const refUserId = entry.key[2];
    const refReward = reward * CONFIG.REFERRAL_PERCENT;
    await kv.atomic()
      .sum(["users", refUserId, "balance"], refReward)
      .sum(["users", refUserId, "refEarnings"], refReward)
      .commit();
    refRewards++;
  }

  const newBalance = (user.value.balance || 0) + reward;
  await kv.atomic()
    .set(["users", userId, "balance"], newBalance)
    .set(["stats", userId, today], { views: viewsToday + 1 })
    .commit();

  ctx.response.body = { 
    success: true,
    reward,
    refRewards,
    balance: newBalance
  };
});

// Вывод средств
router.post("/api/withdraw", async (ctx) => {
  const { userId, wallet, amount } = await ctx.request.body().value;
  
  if (amount < CONFIG.MIN_WITHDRAW) {
    ctx.response.status = 400;
    ctx.response.body = { error: `Minimum withdrawal: $${CONFIG.MIN_WITHDRAW}` };
    return;
  }

  const user = await kv.get(["users", userId]);
  if (!user.value || user.value.balance < amount) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Insufficient balance" };
    return;
  }

  const withdrawId = crypto.randomUUID();
  await kv.atomic()
    .set(["withdrawals", withdrawId], {
      userId,
      amount,
      wallet,
      status: "pending",
      date: new Date().toISOString()
    })
    .sum(["users", userId, "balance"], -amount)
    .commit();

  ctx.response.body = { success: true, withdrawId };
});

app.use(router.routes());
await app.listen({ port: PORT });
