// server.ts
import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

interface User {
  id: string;
  balance: number;
  refCode: string;
  refBy?: string;
  refCount: number;
  refEarnings: number;
  completedTasks: string[];
  createdAt: Date;
}

interface Task {
  id: string;
  title: string;
  description: string;
  reward: number;
  url: string;
  cooldown: number;
  createdAt: Date;
}

interface Withdrawal {
  id: string;
  userId: string;
  wallet: string;
  amount: number;
  status: "pending" | "completed" | "rejected";
  date: Date;
}

const kv = await Deno.openKv();

const app = new Application();
const router = new Router();

// Конфигурация (лучше вынести в переменные окружения)
const CONFIG = {
  adminPassword: Deno.env.get("ADMIN_PASSWORD") || "AdGramAdmin777",
  secretKey: Deno.env.get("SECRET_KEY") || "wagner4625",
  rewardPerAd: 0.0003,
  dailyLimit: 30,
  minWithdraw: 1.00,
  referralPercent: 0.15,
  port: 8000,
};

// Middleware для проверки авторизации администратора
const adminAuth = async (ctx: any, next: any) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Unauthorized" };
    return;
  }

  const token = authHeader.split(" ")[1];
  const validToken = await kv.get(["admin_tokens", token]);

  if (!validToken.value) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid token" };
    return;
  }

  await next();
};

// API Routes
router
  .get("/api/health", (ctx) => {
    ctx.response.body = { status: "ok" };
  })
  .post("/api/register", async (ctx) => {
    const { refCode } = await ctx.request.body().value;
    const userId = `user_${crypto.randomUUID()}`;
    const userRefCode = Math.random().toString(36).substring(2, 10).toUpperCase();

    const user: User = {
      id: userId,
      balance: 0,
      refCode: userRefCode,
      refCount: 0,
      refEarnings: 0,
      completedTasks: [],
      createdAt: new Date(),
    };

    if (refCode) {
      const referrer = await findUserByRefCode(refCode);
      if (referrer) {
        user.refBy = referrer.id;
      }
    }

    await kv.set(["users", userId], user);
    ctx.response.body = { userId, refCode: userRefCode };
  })
  .get("/api/user/:userId", async (ctx) => {
    const user = await kv.get<User>(["users", ctx.params.userId]);
    if (!user.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }
    ctx.response.body = user.value;
  })
  .get("/api/stats/:userId/:date", async (ctx) => {
    const stats = await kv.get<number>(["stats", ctx.params.userId, ctx.params.date]);
    ctx.response.body = { views: stats.value || 0 };
  })
  .get("/api/reward", async (ctx) => {
    const userId = ctx.request.url.searchParams.get("userid");
    const key = ctx.request.url.searchParams.get("key");

    if (key !== CONFIG.secretKey) {
      ctx.response.status = 403;
      ctx.response.body = { error: "Invalid key" };
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    const statsKey = ["stats", userId, today];
    const stats = await kv.get<number>(statsKey);
    const views = (stats.value || 0) + 1;

    if (views > CONFIG.dailyLimit) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Daily limit reached" };
      return;
    }

    await kv.set(statsKey, views);
    
    const user = await kv.get<User>(["users", userId]);
    if (!user.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }

    const newBalance = user.value.balance + CONFIG.rewardPerAd;
    await kv.set(["users", userId], { ...user.value, balance: newBalance });

    // Если есть реферер, начисляем ему процент
    if (user.value.refBy) {
      const referrer = await kv.get<User>(["users", user.value.refBy]);
      if (referrer.value) {
        const reward = CONFIG.rewardPerAd * CONFIG.referralPercent;
        await kv.set(["users", user.value.refBy], {
          ...referrer.value,
          refEarnings: referrer.value.refEarnings + reward,
          balance: referrer.value.balance + reward,
        });
      }
    }

    ctx.response.body = { reward: CONFIG.rewardPerAd };
  })
  .post("/api/withdraw", async (ctx) => {
    const { userId, wallet, amount } = await ctx.request.body().value;

    if (amount < CONFIG.minWithdraw) {
      ctx.response.status = 400;
      ctx.response.body = { error: `Minimum withdrawal is $${CONFIG.minWithdraw}` };
      return;
    }

    const user = await kv.get<User>(["users", userId]);
    if (!user.value || user.value.balance < amount) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Insufficient balance" };
      return;
    }

    const withdrawalId = `wd_${crypto.randomUUID()}`;
    const withdrawal: Withdrawal = {
      id: withdrawalId,
      userId,
      wallet,
      amount,
      status: "pending",
      date: new Date(),
    };

    await kv.set(["withdrawals", withdrawalId], withdrawal);
    await kv.set(["users", userId], { ...user.value, balance: user.value.balance - amount });

    ctx.response.body = { withdrawId: withdrawalId };
  })
  .post("/api/user/:userId/complete-task", async (ctx) => {
    const { taskId } = await ctx.request.body().value;
    const user = await kv.get<User>(["users", ctx.params.userId]);

    if (!user.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "User not found" };
      return;
    }

    if (user.value.completedTasks.includes(taskId)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Task already completed" };
      return;
    }

    const task = await kv.get<Task>(["tasks", taskId]);
    if (!task.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Task not found" };
      return;
    }

    const updatedUser: User = {
      ...user.value,
      balance: user.value.balance + task.value.reward,
      completedTasks: [...user.value.completedTasks, taskId],
    };

    await kv.set(["users", ctx.params.userId], updatedUser);
    ctx.response.body = updatedUser;
  })
  // Admin routes
  .post("/admin/auth", async (ctx) => {
    const { password } = await ctx.request.body().value;
    if (password !== CONFIG.adminPassword) {
      ctx.response.status = 401;
      ctx.response.body = { error: "Invalid password" };
      return;
    }

    const token = crypto.randomUUID();
    await kv.set(["admin_tokens", token], { valid: true }, { expireIn: 86400000 }); // 24 hours

    ctx.response.body = { token };
  })
  .get("/admin/withdrawals", adminAuth, async (ctx) => {
    const status = ctx.request.url.searchParams.get("status") || "pending";
    const withdrawals: Withdrawal[] = [];

    for await (const entry of kv.list<Withdrawal>({ prefix: ["withdrawals"] })) {
      if (entry.value.status === status) {
        withdrawals.push(entry.value);
      }
    }

    ctx.response.body = withdrawals.sort((a, b) => b.date.getTime() - a.date.getTime());
  })
  .put("/admin/withdrawals/:id", adminAuth, async (ctx) => {
    const { status } = await ctx.request.body().value;
    const withdrawal = await kv.get<Withdrawal>(["withdrawals", ctx.params.id]);

    if (!withdrawal.value) {
      ctx.response.status = 404;
      ctx.response.body = { error: "Withdrawal not found" };
      return;
    }

    const updatedWithdrawal: Withdrawal = { ...withdrawal.value, status };
    await kv.set(["withdrawals", ctx.params.id], updatedWithdrawal);
    ctx.response.body = updatedWithdrawal;
  })
  .get("/admin/tasks", adminAuth, async (ctx) => {
    const tasks: Task[] = [];
    for await (const entry of kv.list<Task>({ prefix: ["tasks"] })) {
      tasks.push(entry.value);
    }
    ctx.response.body = tasks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  })
  .post("/admin/tasks", adminAuth, async (ctx) => {
    const { title, reward, description, url, cooldown } = await ctx.request.body().value;
    const taskId = `task_${crypto.randomUUID()}`;

    const task: Task = {
      id: taskId,
      title,
      description,
      reward: parseFloat(reward),
      url,
      cooldown: parseInt(cooldown) || 10,
      createdAt: new Date(),
    };

    await kv.set(["tasks", taskId], task);
    ctx.response.body = task;
  })
  .delete("/admin/tasks/:id", adminAuth, async (ctx) => {
    await kv.delete(["tasks", ctx.params.id]);
    ctx.response.body = { success: true };
  })
  .get("/api/tasks", async (ctx) => {
    const tasks: Task[] = [];
    for await (const entry of kv.list<Task>({ prefix: ["tasks"] })) {
      tasks.push(entry.value);
    }
    ctx.response.body = tasks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  });

// Helper functions
async function findUserByRefCode(refCode: string): Promise<User | null> {
  for await (const entry of kv.list<User>({ prefix: ["users"] })) {
    if (entry.value.refCode === refCode) {
      return entry.value;
    }
  }
  return null;
}

// Middleware
app.use(oakCors());
app.use(router.routes());
app.use(router.allowedMethods());

// Static files (for frontend)
app.use(async (ctx) => {
  try {
    await ctx.send({
      root: `${Deno.cwd()}/public`,
      index: "index.html",
    });
  } catch {
    ctx.response.status = 404;
    ctx.response.body = "Not found";
  }
});

console.log(`Server running on http://localhost:${CONFIG.port}`);
await app.listen({ port: CONFIG.port });
