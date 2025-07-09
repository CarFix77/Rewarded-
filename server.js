// Импорты
import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { DB } from "https://deno.land/x/sqlite/mod.ts";

// Конфигурация
const CONFIG = {
  SECRET_KEY: "Jora1513", // Ваш ключ API
  REWARD_AMOUNT: 0.0003, // $ за просмотр
  REF_PERCENT: 0.15, // 15% реферальных
  MIN_WITHDRAW: 1.00, // Минимальный вывод
  ADMIN_PASSWORD: "AdGramAdmin777" // Пароль для админки
};

// Инициализация БД
const db = new DB("db.sqlite");
db.execute(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    balance REAL DEFAULT 0,
    referrals INTEGER DEFAULT 0,
    ref_earnings REAL DEFAULT 0
  )
`);

db.execute(`
  CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    amount REAL,
    wallet TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.execute(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    reward REAL,
    description TEXT
  )
`);

// Сервер
const app = new Application();
const router = new Router();

// Middleware для проверки ключа API
router.use(async (ctx, next) => {
  const key = ctx.request.url.searchParams.get("key");
  if (key !== CONFIG.SECRET_KEY && ctx.request.url.pathname !== "/admin") {
    ctx.response.status = 403;
    ctx.response.body = { error: "Invalid API key" };
    return;
  }
  await next();
});

// Reward URL для AdGram
router.get("/reward", async (ctx) => {
  const userId = ctx.request.url.searchParams.get("userid");
  if (!userId) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Missing userid" };
    return;
  }

  // Создаем пользователя если не существует
  db.query("INSERT OR IGNORE INTO users (id) VALUES (?)", [userId]);

  // Начисляем за просмотр
  db.query("UPDATE users SET balance = balance + ? WHERE id = ?", [
    CONFIG.REWARD_AMOUNT,
    userId
  ]);

  // Реферальное начисление (если есть реферер)
  const ref = ctx.request.url.searchParams.get("ref");
  if (ref && ref !== userId) {
    const refReward = CONFIG.REWARD_AMOUNT * CONFIG.REF_PERCENT;
    db.query(
      "UPDATE users SET balance = balance + ?, ref_earnings = ref_earnings + ?, referrals = referrals + 1 WHERE id = ?",
      [refReward, refReward, ref]
    );
  }

  ctx.response.body = {
    success: true,
    balance: db.query("SELECT balance FROM users WHERE id = ?", [userId])[0]?.balance
  };
});

// Вывод средств
router.post("/withdraw", async (ctx) => {
  const { userId, amount, wallet } = await ctx.request.body().value;

  if (!userId || !amount || !wallet) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Missing data" };
    return;
  }

  const balance = db.query("SELECT balance FROM users WHERE id = ?", [userId])[0]?.balance;
  if (balance < CONFIG.MIN_WITHDRAW || amount < CONFIG.MIN_WITHDRAW) {
    ctx.response.status = 400;
    ctx.response.body = { error: `Minimum withdraw is $${CONFIG.MIN_WITHDRAW}` };
    return;
  }

  if (balance < amount) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Insufficient balance" };
    return;
  }

  // Списание и создание заявки
  db.query("UPDATE users SET balance = balance - ? WHERE id = ?", [amount, userId]);
  db.query(
    "INSERT INTO withdrawals (user_id, amount, wallet) VALUES (?, ?, ?)",
    [userId, amount, wallet]
  );

  ctx.response.body = { success: true };
});

// Админ-панель (веб-интерфейс)
router.get("/admin", async (ctx) => {
  if (ctx.request.url.searchParams.get("password") !== CONFIG.ADMIN_PASSWORD) {
    ctx.response.status = 403;
    ctx.response.body = "Access denied";
    return;
  }

  // Статистика
  const stats = {
    users: db.query("SELECT COUNT(*) FROM users")[0],
    balance: db.query("SELECT SUM(balance) FROM users")[0],
    withdrawals: db.query("SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT 50")
  };

  // Генерация HTML
  ctx.response.body = `
    <h1>AdGram Admin</h1>
    <p>Users: ${stats.users}</p>
    <p>Total balance: $${stats.balance}</p>
    <h2>Recent withdrawals</h2>
    <ul>
      ${stats.withdrawals.map(w => `
        <li>${w.user_id}: $${w.amount} → ${w.wallet} (${w.status})</li>
      `).join("")}
    </ul>
  `;
});

app.use(router.routes());
await app.listen({ port: 8000 });
