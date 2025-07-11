// server.ts
import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";

// Типы данных
interface User {
  userId: string;
  balance: number;
  adViews: number;
  lastAdTime: string | null;
  referrals: number;
  referralEarnings: number;
  referrer: string | null;
  completedTasks: string[];
  withdrawalHistory: Withdrawal[];
}

interface Withdrawal {
  id: string;
  userId: string;
  wallet: string;
  amount: number;
  status: "pending" | "completed" | "rejected";
  date: string;
}

interface Task {
  id: string;
  title: string;
  reward: number;
  description: string;
  url: string;
  cooldown: number;
  isActive: boolean;
}

interface AdminSession {
  token: string;
  expiresAt: number;
}

// Конфигурация
const CONFIG = {
  rewardPerAd: 0.0003,
  dailyLimit: 30, // 30 просмотров в 24 часа
  minWithdraw: 1.00,
  referralPercent: 0.15,
  adminPassword: "8223Nn8223",
  adCooldown: 10,
  sessionExpiry: 3600, // 1 час в секундах
  port: 8000
};

// База данных в памяти
const db: {
  users: Record<string, User>;
  withdrawals: Record<string, Withdrawal>;
  tasks: Task[];
  adminSessions: Record<string, AdminSession>;
} = {
  users: {},
  withdrawals: {},
  tasks: [],
  adminSessions: {}
};

// Инициализация сервера
const app = new Application();
const router = new Router();

// Middleware
app.use(oakCors());
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
function generateId() {
  return Date.now().toString() + Math.random().toString(36).substr(2, 5);
}

function isAdminAuthorized(ctx: any): boolean {
  const token = ctx.request.headers.get("authorization")?.split(" ")[1];
  return !!token && !!db.adminSessions[token] && db.adminSessions[token].expiresAt > Date.now();
}

// API Endpoints

// Пользовательские endpoints
router.get("/api/user/:userId", async (ctx) => {
  const { userId } = ctx.params;
  
  if (!db.users[userId]) {
    // Создаем нового пользователя
    db.users[userId] = {
      userId,
      balance: 0,
      adViews: 0,
      lastAdTime: null,
      referrals: 0,
      referralEarnings: 0,
      referrer: null,
      completedTasks: [],
      withdrawalHistory: []
    };
  }
  
  // Проверяем сброс дневного лимита
  const user = db.users[userId];
  if (user.lastAdTime) {
    const lastAdDate = new Date(user.lastAdTime);
    const now = new Date();
    const diffHours = (now.getTime() - lastAdDate.getTime()) / (1000 * 60 * 60);
    
    if (diffHours >= 24) {
      user.adViews = 0;
      user.lastAdTime = null;
    }
  }
  
  ctx.response.body = user;
});

router.post("/api/user/:userId/watch-ad", async (ctx) => {
  const { userId } = ctx.params;
  const user = db.users[userId];
  
  if (!user) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User not found" };
    return;
  }
  
  // Проверка лимита
  if (user.adViews >= CONFIG.dailyLimit) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Daily limit reached" };
    return;
  }
  
  // Обновляем данные пользователя
  user.adViews += 1;
  user.balance = parseFloat((user.balance + CONFIG.rewardPerAd).toFixed(6));
  user.lastAdTime = new Date().toISOString();
  
  ctx.response.body = user;
});

router.post("/api/user/:userId/complete-task", async (ctx) => {
  const { userId } = ctx.params;
  const { taskId } = await ctx.request.body().value;
  
  if (!db.users[userId]) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User not found" };
    return;
  }
  
  const task = db.tasks.find(t => t.id === taskId && t.isActive);
  if (!task) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Task not found or inactive" };
    return;
  }
  
  if (db.users[userId].completedTasks.includes(taskId)) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Task already completed" };
    return;
  }
  
  // Начисляем награду
  db.users[userId].balance = parseFloat((db.users[userId].balance + task.reward).toFixed(6));
  db.users[userId].completedTasks.push(taskId);
  
  ctx.response.body = db.users[userId];
});

router.post("/api/withdrawals", async (ctx) => {
  const { userId, wallet, amount } = await ctx.request.body().value;
  
  if (!db.users[userId]) {
    ctx.response.status = 404;
    ctx.response.body = { error: "User not found" };
    return;
  }
  
  if (isNaN(amount) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Invalid amount" };
    return;
  }
  
  if (amount < CONFIG.minWithdraw) {
    ctx.response.status = 400;
    ctx.response.body = { error: `Minimum withdrawal is $${CONFIG.minWithdraw}` };
    return;
  }
  
  if (amount > db.users[userId].balance) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Insufficient balance" };
    return;
  }
  
  // Создаем заявку на вывод
  const withdrawal: Withdrawal = {
    id: generateId(),
    userId,
    wallet,
    amount: parseFloat(amount.toFixed(2)),
    status: "pending",
    date: new Date().toISOString()
  };
  
  db.withdrawals[withdrawal.id] = withdrawal;
  db.users[userId].withdrawalHistory.push(withdrawal);
  
  // Вычитаем сумму из баланса пользователя
  db.users[userId].balance = parseFloat((db.users[userId].balance - amount).toFixed(6));
  
  // Если есть реферер, начисляем ему бонус
  if (db.users[userId].referrer) {
    const referrerId = db.users[userId].referrer;
    if (db.users[referrerId]) {
      const referralBonus = parseFloat((amount * CONFIG.referralPercent).toFixed(6));
      db.users[referrerId].referralEarnings += referralBonus;
    }
  }
  
  ctx.response.body = withdrawal;
});

// Задания
router.get("/api/tasks", async (ctx) => {
  ctx.response.body = db.tasks.filter(task => task.isActive);
});

// Админ endpoints
router.post("/api/admin/login", async (ctx) => {
  const { password } = await ctx.request.body().value;
  
  if (password !== CONFIG.adminPassword) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid password" };
    return;
  }
  
  // Создаем сессию
  const token = generateId();
  db.adminSessions[token] = {
    token,
    expiresAt: Date.now() + CONFIG.sessionExpiry * 1000
  };
  
  ctx.response.body = { token };
});

router.get("/api/admin/withdrawals", async (ctx) => {
  if (!isAdminAuthorized(ctx)) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Unauthorized" };
    return;
  }
  
  const { status } = ctx.request.url.searchParams;
  let withdrawals = Object.values(db.withdrawals);
  
  if (status) {
    withdrawals = withdrawals.filter(w => w.status === status);
  }
  
  // Добавляем информацию о пользователе
  const result = withdrawals.map(w => ({
    ...w,
    user: db.users[w.userId] ? {
      balance: db.users[w.userId].balance,
      referrals: db.users[w.userId].referrals,
      referralEarnings: db.users[w.userId].referralEarnings
    } : null
  }));
  
  ctx.response.body = result;
});

router.put("/api/admin/withdrawals/:id", async (ctx) => {
  if (!isAdminAuthorized(ctx)) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Unauthorized" };
    return;
  }
  
  const { id } = ctx.params;
  const { status } = await ctx.request.body().value;
  
  if (!db.withdrawals[id]) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Withdrawal not found" };
    return;
  }
  
  // Если отклоняем заявку, возвращаем средства
  if (status === "rejected" && db.withdrawals[id].status === "pending") {
    const userId = db.withdrawals[id].userId;
    if (db.users[userId]) {
      db.users[userId].balance = parseFloat(
        (db.users[userId].balance + db.withdrawals[id].amount).toFixed(6)
      );
      
      // Отменяем реферальный бонус, если был
      if (db.users[userId].referrer) {
        const referrerId = db.users[userId].referrer;
        if (db.users[referrerId]) {
          const referralBonus = db.withdrawals[id].amount * CONFIG.referralPercent;
          db.users[referrerId].referralEarnings = parseFloat(
            (db.users[referrerId].referralEarnings - referralBonus).toFixed(6)
          );
        }
      }
    }
  }
  
  db.withdrawals[id].status = status;
  ctx.response.body = db.withdrawals[id];
});

router.get("/api/admin/tasks", async (ctx) => {
  if (!isAdminAuthorized(ctx)) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Unauthorized" };
    return;
  }
  
  ctx.response.body = db.tasks;
});

router.post("/api/admin/tasks", async (ctx) => {
  if (!isAdminAuthorized(ctx)) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Unauthorized" };
    return;
  }
  
  const taskData = await ctx.request.body().value;
  
  const task: Task = {
    id: generateId(),
    title: taskData.title,
    reward: parseFloat(taskData.reward),
    description: taskData.description,
    url: taskData.url,
    cooldown: parseInt(taskData.cooldown) || 10,
    isActive: true
  };
  
  if (!task.title || !task.reward || !task.description || !task.url) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Missing required fields" };
    return;
  }
  
  db.tasks.push(task);
  ctx.response.body = task;
});

router.put("/api/admin/tasks/:id", async (ctx) => {
  if (!isAdminAuthorized(ctx)) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Unauthorized" };
    return;
  }
  
  const { id } = ctx.params;
  const taskData = await ctx.request.body().value;
  const taskIndex = db.tasks.findIndex(t => t.id === id);
  
  if (taskIndex === -1) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Task not found" };
    return;
  }
  
  db.tasks[taskIndex] = {
    ...db.tasks[taskIndex],
    ...taskData
  };
  
  ctx.response.body = db.tasks[taskIndex];
});

router.delete("/api/admin/tasks/:id", async (ctx) => {
  if (!isAdminAuthorized(ctx)) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Unauthorized" };
    return;
  }
  
  const { id } = ctx.params;
  db.tasks = db.tasks.filter(task => task.id !== id);
  ctx.response.body = { success: true };
});

router.get("/api/admin/users", async (ctx) => {
  if (!isAdminAuthorized(ctx)) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Unauthorized" };
    return;
  }
  
  const { limit = 50, offset = 0 } = ctx.request.url.searchParams;
  const users = Object.values(db.users)
    .sort((a, b) => b.balance - a.balance)
    .slice(parseInt(offset), parseInt(offset) + parseInt(limit));
  
  ctx.response.body = users;
});

// Старт сервера
console.log(`Server running on http://localhost:${CONFIG.port}`);
await app.listen({ port: CONFIG.port });
