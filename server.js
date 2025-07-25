import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223",
  SECRET_KEY: "wagner46375",
  TASK_REWARDS: {
    subscribe: 0.009,
    view_post: 0.0005,
    like: 0.0003,
    repost: 0.001
  }
};

const kv = await Deno.openKv();
const app = new Application();
const router = new Router();

// Настройка CORS
app.use(oakCors({ origin: "*" }));

// Middleware для логирования
app.use(async (ctx, next) => {
  await next();
  console.log(`${ctx.request.method} ${ctx.request.url.pathname}`);
});

// Корневой маршрут с HTML
router.get("/", (ctx) => {
  ctx.response.type = "text/html";
  ctx.response.body = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>AdRewards Server</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; }
          h1 { color: #2c3e50; }
          pre { background: #f4f4f4; padding: 10px; border-radius: 5px; overflow-x: auto; }
          .endpoint { margin-bottom: 20px; padding: 15px; background: #f9f9f9; border-radius: 5px; }
        </style>
      </head>
      <body>
        <h1>AdRewards Server is Running</h1>
        <p>Available endpoints:</p>
        
        <div class="endpoint">
          <h3>GET /reward</h3>
          <p>Начисление вознаграждения за просмотр рекламы</p>
          <pre>https://your-server.deno.dev/reward?userid=USER_ID&secret=wagner46375</pre>
        </div>
        
        <div class="endpoint">
          <h3>POST /register</h3>
          <p>Регистрация нового пользователя</p>
          <pre>{ "refCode": "OPTIONAL_REF_CODE" }</pre>
        </div>
        
        <div class="endpoint">
          <h3>POST /complete-task</h3>
          <p>Завершение задания</p>
          <pre>{ "userId": "USER_ID", "taskType": "subscribe/view_post/like/repost" }</pre>
        </div>
      </body>
    </html>
  `;
});

// Регистрация пользователя
router.post("/register", async (ctx) => {
  try {
    const { refCode } = await ctx.request.body().value;
    const userId = `user_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const userRefCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    await kv.set(["users", userId], {
      balance: 0,
      refCode: userRefCode,
      refCount: 0,
      refEarnings: 0,
      createdAt: new Date().toISOString()
    });

    // Реферальная система
    if (refCode) {
      for await (const entry of kv.list({ prefix: ["users"] })) {
        if (entry.value.refCode === refCode) {
          const bonus = CONFIG.REWARD_PER_AD * CONFIG.REFERRAL_PERCENT;
          await kv.set(entry.key, {
            ...entry.value,
            refCount: entry.value.refCount + 1,
            refEarnings: entry.value.refEarnings + bonus,
            balance: entry.value.balance + bonus
          });
          break;
        }
      }
    }

    ctx.response.body = {
      success: true,
      userId,
      refCode: userRefCode,
      refLink: `${ctx.request.url.origin}?ref=${userRefCode}`
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Registration failed" };
  }
});

// Начисление вознаграждения
router.get("/reward", async (ctx) => {
  try {
    const userId = ctx.request.url.searchParams.get("userid");
    const secret = ctx.request.url.searchParams.get("secret");

    if (secret !== CONFIG.SECRET_KEY) {
      ctx.response.status = 401;
      ctx.response.body = { error: "Invalid secret key" };
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    const user = (await kv.get(["users", userId])).value || { balance: 0 };
    const dailyViews = (await kv.get(["stats", userId, today])).value || 0;

    if (dailyViews >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 429;
      ctx.response.body = { error: "Daily limit reached" };
      return;
    }

    const newBalance = user.balance + CONFIG.REWARD_PER_AD;
    await kv.atomic()
      .set(["users", userId], { ...user, balance: newBalance })
      .set(["stats", userId, today], dailyViews + 1)
      .commit();

    ctx.response.body = {
      success: true,
      reward: CONFIG.REWARD_PER_AD,
      balance: newBalance,
      viewsToday: dailyViews + 1,
      viewsLeft: CONFIG.DAILY_LIMIT - (dailyViews + 1)
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Reward processing failed" };
  }
});

// Задания
router.post("/complete-task", async (ctx) => {
  try {
    const { userId, taskType } = await ctx.request.body().value;
    
    if (!CONFIG.TASK_REWARDS[taskType]) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid task type" };
      return;
    }

    const user = (await kv.get(["users", userId])).value;
    if (!user) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }

    const reward = CONFIG.TASK_REWARDS[taskType];
    const newBalance = user.balance + reward;
    
    await kv.set(["users", userId], {
      ...user,
      balance: newBalance,
      completedTasks: [...(user.completedTasks || []), {
        type: taskType,
        date: new Date().toISOString(),
        reward: reward
      }]
    });

    ctx.response.body = {
      success: true,
      reward: reward,
      balance: newBalance,
      taskType: taskType
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Task completion failed" };
  }
});

// Вывод средств
router.post("/withdraw", async (ctx) => {
  try {
    const { userId, wallet, amount } = await ctx.request.body().value;
    const user = (await kv.get(["users", userId])).value;

    if (!user || amount < CONFIG.MIN_WITHDRAW || user.balance < amount) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid withdrawal request" };
      return;
    }

    const withdrawId = `wd_${Date.now()}`;
    await kv.atomic()
      .set(["users", userId], { ...user, balance: user.balance - amount })
      .set(["withdrawals", withdrawId], {
        userId,
        amount,
        wallet,
        date: new Date().toISOString(),
        status: "pending"
      })
      .commit();

    ctx.response.body = { 
      success: true, 
      withdrawId,
      newBalance: user.balance - amount
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Withdrawal processing failed" };
  }
});

// Админ-панель
router.post("/admin/login", async (ctx) => {
  const { password } = await ctx.request.body().value;
  if (password === CONFIG.ADMIN_PASSWORD) {
    ctx.response.body = { 
      success: true,
      token: "admin_token_" + Math.random().toString(36).substring(2)
    };
  } else {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid credentials" };
  }
});

// Запуск сервера
console.log("Server running on http://localhost:8000");
await app.listen({ port: 8000 });
