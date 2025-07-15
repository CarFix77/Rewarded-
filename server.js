import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_TOKEN: "8223Nn8223",
  REWARD_SECRET: "wagner46rus",
  API_KEY: "sk_test_123456789"
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Middleware
app.use(oakCors({ origin: "*" }));
app.use(async (ctx, next) => {
  console.log(`${ctx.request.method} ${ctx.request.url.pathname}`);
  await next();
});

// Helper functions
function generateReferralCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({length: 8}, () => 
    chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function getUser(userId) {
  return await kv.get(["users", userId]);
}

async function updateUser(userId, data) {
  const user = await getUser(userId);
  await kv.set(["users", userId], { ...user.value, ...data });
}

// Routes
router
  // Регистрация пользователя
  .post("/api/register", async (ctx) => {
    try {
      const { telegramId, refCode } = await ctx.request.body().value;
      const userId = `user_${crypto.randomUUID()}`;
      const userData = {
        balance: 0,
        refCode: generateReferralCode(),
        telegramId: telegramId || null,
        createdAt: new Date().toISOString()
      };

      if (refCode) {
        for await (const entry of kv.list({ prefix: ["users"] })) {
          if (entry.value.refCode === refCode) {
            userData.refBy = refCode;
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

      ctx.response.body = { userId, refCode: userData.refCode };
    } catch (error) {
      ctx.response.status = 500;
      ctx.response.body = { error: "Registration failed" };
    }
  })

  // Начисление за рекламу
  .get("/api/reward", async (ctx) => {
    try {
      const userId = ctx.request.url.searchParams.get("userid");
      if (!userId) {
        ctx.response.status = 400;
        ctx.response.body = { error: "User ID required" };
        return;
      }

      const today = new Date().toISOString().split("T")[0];
      const [user, stats] = await Promise.all([
        getUser(userId),
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
  })

  // Получение данных пользователя
  .get("/api/user/:userId", async (ctx) => {
    try {
      const userId = ctx.params.userId;
      const user = await getUser(userId);
      
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
  })

  // Вывод средств
  .post("/api/withdraw", async (ctx) => {
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

      const user = await getUser(userId);
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

// Admin routes
router
  .get("/admin/users", async (ctx) => {
    const users = [];
    for await (const entry of kv.list({ prefix: ["users"] })) {
      users.push(entry.value);
    }
    ctx.response.body = users;
  })
  .put("/admin/withdrawals/:id", async (ctx) => {
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
  });

app.use(router.routes());
app.use(router.allowedMethods());

console.log("Server running on http://localhost:8000");
await app.listen({ port: 8000 });
