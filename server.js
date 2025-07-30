import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";

// Конфигурация
const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  WEBHOOK_SECRET: "wagner1080",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223",
  TASK_REWARDS: {
    FOLLOW: 0.10,
    LIKE: 0.05,
    RETWEET: 0.07,
    COMMENT: 0.15
  },
  STORAGE: {
    RETENTION_DAYS: 60,
    CLEANUP_INTERVAL: 24 * 60 * 60 * 1000,
    PREFIXES: {
      USERS: "u",
      VIEWS: "v",
      WITHDRAWALS: "w",
      TASKS: "t"
    }
  }
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Утилиты
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Оптимизация хранилища
async function optimizeStorage() {
  console.log("[Optimize] Starting storage optimization...");
  
  // Миграция пользователей
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const newKey = [CONFIG.STORAGE.PREFIXES.USERS, entry.key[1]];
    await kv.set(newKey, {
      b: entry.value.balance || 0,
      r: entry.value.refCode || generateId().toString(),
      rc: entry.value.refCount || 0,
      re: entry.value.refEarnings || 0,
      ct: entry.value.completedTasks || [],
      cr: new Date(entry.value.createdAt).getTime() || Date.now()
    });
    await kv.delete(entry.key);
  }
  
  console.log("[Optimize] Storage optimization completed");
}

// Очистка старых данных
async function cleanupOldData() {
  const cutoff = Date.now() - CONFIG.STORAGE.RETENTION_DAYS * 86400000;
  let deletedCount = 0;

  // Очистка просмотров
  for await (const entry of kv.list({ prefix: [CONFIG.STORAGE.PREFIXES.VIEWS] })) {
    const date = new Date(entry.key[2]).getTime();
    if (date < cutoff) {
      await kv.delete(entry.key);
      deletedCount++;
    }
  }

  // Очистка выплат
  for await (const entry of kv.list({ prefix: [CONFIG.STORAGE.PREFIXES.WITHDRAWALS] })) {
    if (entry.value.s === 'completed' && entry.value.d < cutoff) {
      await kv.delete(entry.key);
      deletedCount++;
    }
  }

  console.log(`[Cleanup] Deleted ${deletedCount} old records`);
}

// Инициализация
async function initialize() {
  await optimizeStorage();
  setInterval(cleanupOldData, CONFIG.STORAGE.CLEANUP_INTERVAL);
  cleanupOldData(); // Immediate first cleanup
}
initialize();

// Middleware
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(async (ctx, next) => {
  console.log(`${ctx.request.method} ${ctx.request.url.pathname}`);
  await next();
});

// API Endpoints
router.post("/register", async (ctx) => {
  try {
    const { refCode } = await ctx.request.body().value;
    const userId = `usr_${generateId()}`;
    const userRefCode = generateId().toString();

    await kv.set([CONFIG.STORAGE.PREFIXES.USERS, userId], {
      b: 0,
      r: userRefCode,
      rc: 0,
      re: 0,
      ct: [],
      cr: Date.now()
    });

    if (refCode) {
      for await (const entry of kv.list({ prefix: [CONFIG.STORAGE.PREFIXES.USERS] })) {
        if (entry.value.r === refCode) {
          const bonus = CONFIG.REWARD_PER_AD * CONFIG.REFERRAL_PERCENT;
          await kv.set(entry.key, {
            ...entry.value,
            rc: entry.value.rc + 1,
            re: entry.value.re + bonus,
            b: entry.value.b + bonus
          });
          break;
        }
      }
    }

    ctx.response.body = {
      userId,
      refCode: userRefCode,
      refLink: `${ctx.request.url.origin}${ctx.request.url.pathname}?ref=${userRefCode}`
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

router.get("/user/:userId", async (ctx) => {
  try {
    const user = (await kv.get([CONFIG.STORAGE.PREFIXES.USERS, ctx.params.userId])).value;
    
    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }
    
    ctx.response.body = {
      userId: ctx.params.userId,
      balance: user.b,
      refCode: user.r,
      refCount: user.rc,
      refEarnings: user.re,
      completedTasks: user.ct,
      createdAt: new Date(user.cr).toISOString()
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

router.get("/reward", async (ctx) => {
  try {
    const userId = ctx.request.url.searchParams.get("userid");
    const secret = ctx.request.url.searchParams.get("secret");

    if (secret !== CONFIG.SECRET_KEY && secret !== CONFIG.WEBHOOK_SECRET) {
      ctx.response.status = 401;
      ctx.response.body = { error: "Invalid secret" };
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    const userKey = [CONFIG.STORAGE.PREFIXES.USERS, userId];
    const user = (await kv.get(userKey)).value || { b: 0 };
    const viewsKey = [CONFIG.STORAGE.PREFIXES.VIEWS, userId, today];
    const dailyViews = (await kv.get(viewsKey)).value || 0;

    if (dailyViews >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 429;
      ctx.response.body = { error: "Daily limit reached" };
      return;
    }

    const newBalance = user.b + CONFIG.REWARD_PER_AD;
    await kv.atomic()
      .set(userKey, { ...user, b: newBalance })
      .set(viewsKey, dailyViews + 1)
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

router.post("/withdraw", async (ctx) => {
  try {
    const { userId, wallet, amount } = await ctx.request.body().value;
    const userKey = [CONFIG.STORAGE.PREFIXES.USERS, userId];
    const user = (await kv.get(userKey)).value;

    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }

    if (amount < CONFIG.MIN_WITHDRAW || user.b < amount) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid withdrawal amount" };
      return;
    }

    const withdrawId = `wd_${generateId()}`;
    await kv.atomic()
      .set(userKey, { ...user, b: user.b - amount })
      .set([CONFIG.STORAGE.PREFIXES.WITHDRAWALS, withdrawId], {
        u: userId,
        a: amount,
        w: wallet,
        d: Date.now(),
        s: "pending"
      })
      .commit();

    ctx.response.body = { success: true, withdrawId };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Админ-эндпоинты
router.post("/admin/login", async (ctx) => {
  try {
    const { password } = await ctx.request.body().value;
    if (password === CONFIG.ADMIN_PASSWORD) {
      ctx.response.body = { 
        success: true, 
        token: "admin_" + generateId() 
      };
    } else {
      ctx.response.status = 401;
      ctx.response.body = { error: "Wrong password" };
    }
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

router.get("/admin/withdrawals", async (ctx) => {
  try {
    const withdrawals = [];
    for await (const entry of kv.list({ prefix: [CONFIG.STORAGE.PREFIXES.WITHDRAWALS] })) {
      withdrawals.push({
        id: entry.key[1],
        userId: entry.value.u,
        amount: entry.value.a,
        wallet: entry.value.w,
        date: new Date(entry.value.d).toISOString(),
        status: entry.value.s
      });
    }
    ctx.response.body = withdrawals;
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Запуск сервера
app.use(router.routes());
app.use(router.allowedMethods());

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
