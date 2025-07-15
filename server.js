import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_TOKEN: "AdGramAdmin777"
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Настройка CORS
app.use(oakCors({
  origin: /^http?:\/\/localhost(:\d+)?$/,
  credentials: true
}));

// Логирование запросов
app.use(async (ctx, next) => {
  console.log(`${ctx.request.method} ${ctx.request.url.pathname}`);
  await next();
});

// Health check endpoint
router.get("/health", (ctx) => {
  ctx.response.body = { status: "OK" };
});

// Регистрация пользователя
router.post("/api/register", async (ctx) => {
  try {
    const { refCode } = await ctx.request.body().value;
    const userId = `user_${crypto.randomUUID()}`;
    const userRefCode = generateReferralCode();
    
    const userData = {
      userId,
      balance: 0,
      refCode: userRefCode,
      refCount: 0,
      refEarnings: 0,
      createdAt: new Date().toISOString()
    };

    if (refCode) {
      for await (const entry of kv.list({ prefix: ["users"] })) {
        if (entry.value.refCode === refCode) {
          userData.referredBy = refCode;
          await kv.atomic()
            .set(["users", userId], userData)
            .sum(["users", entry.key[1], "refCount"], 1)
            .commit();
          break;
        }
      }
    } else {
      await kv.set(["users", userId], userData);
    }

    ctx.response.body = { userId, refCode: userRefCode };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Registration failed" };
  }
});

// Начисление за просмотр рекламы
router.get("/api/reward", async (ctx) => {
  try {
    const userId = ctx.request.url.searchParams.get("userid");
    if (!userId) {
      ctx.response.status = 400;
      ctx.response.body = { error: "User ID required" };
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    const [user, stats] = await Promise.all([
      kv.get(["users", userId]),
      kv.get(["stats", userId, today])
    ]);

    if (!user.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }

    const viewsToday = stats.value?.views || 0;
    if (viewsToday >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 429;
      ctx.response.body = { error: "Daily limit reached" };
      return;
    }

    const reward = CONFIG.REWARD_PER_AD;
    await kv.atomic()
      .sum(["users", userId, "balance"], reward)
      .set(["stats", userId, today], { views: viewsToday + 1 })
      .commit();

    ctx.response.body = { status: "OK", reward };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Reward processing failed" };
  }
});

// Получение данных пользователя
router.get("/api/user/:userId", async (ctx) => {
  try {
    const userId = ctx.params.userId;
    const user = await kv.get(["users", userId]);
    
    if (!user.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }
    
    ctx.response.body = user.value;
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to get user data" };
  }
});

// Вывод средств
router.post("/api/withdraw", async (ctx) => {
  try {
    const { userId, wallet, amount } = await ctx.request.body().value;
    
    if (!userId || !wallet || !amount) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid parameters" };
      return;
    }

    if (amount < CONFIG.MIN_WITHDRAW) {
      ctx.response.status = 400;
      ctx.response.body = { error: `Minimum withdrawal is $${CONFIG.MIN_WITHDRAW}` };
      return;
    }

    const user = await kv.get(["users", userId]);
    if (!user.value || user.value.balance < amount) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Insufficient balance" };
      return;
    }

    const withdrawId = `wd_${Date.now()}`;
    await kv.atomic()
      .set(["withdrawals", withdrawId], {
        userId,
        wallet,
        amount,
        status: "pending",
        date: new Date().toISOString()
      })
      .sum(["users", userId, "balance"], -amount)
      .commit();

    ctx.response.body = { success: true, withdrawId };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Withdrawal processing failed" };
  }
});

// Получение заданий
router.get("/api/tasks", async (ctx) => {
  try {
    const tasks = [];
    for await (const entry of kv.list({ prefix: ["tasks"] })) {
      tasks.push(entry.value);
    }
    ctx.response.body = tasks;
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to get tasks" };
  }
});

// Админ-маршруты
router
  .get("/admin/withdrawals", async (ctx) => {
    try {
      const status = ctx.request.url.searchParams.get("status") || "pending";
      const withdrawals = [];
      
      for await (const entry of kv.list({ prefix: ["withdrawals"] })) {
        if (entry.value.status === status) {
          withdrawals.push(entry.value);
        }
      }
      
      ctx.response.body = withdrawals;
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = { error: "Failed to get withdrawals" };
    }
  })
  .put("/admin/withdrawals/:id", async (ctx) => {
    try {
      const { status } = await ctx.request.body().value;
      const id = ctx.params.id;
      
      const withdrawal = await kv.get(["withdrawals", id]);
      if (!withdrawal.value) {
        ctx.response.status = 404;
        ctx.response.body = { error: "Withdrawal not found" };
        return;
      }

      await kv.set(["withdrawals", id], { ...withdrawal.value, status });
      ctx.response.body = { success: true };
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = { error: "Failed to update withdrawal" };
    }
  });

// Обработка ошибок
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error(err);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

// Вспомогательные функции
function generateReferralCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({length: 8}, () => 
    chars[Math.floor(Math.random() * chars.length)]).join('');
}

console.log("Server running on http://localhost:8000");
await app.listen({ port: 8000 });
