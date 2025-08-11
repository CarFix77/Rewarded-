import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Конфигурация
const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223",
  BONUS_THRESHOLD: 200,    // Каждые 200 просмотров
  BONUS_AMOUNT: 0.005,     // Награда за каждые 200 просмотров
  SUPABASE_URL: "https://ibnxrjoxhjpmkjwzpngw.supabase.co",
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlibnhyam94aGpwbWtqd3pwbmd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ2NTExNzEsImV4cCI6MjA3MDIyNzE3MX0.9OMEfH5wyakx7iCrZNiw-udkunrdF8kakZRzKvs7Xus"
};

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const app = new Application();
const router = new Router();

// Включение CORS
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Обработка JSON тел запросов
app.use(async (ctx, next) => {
  if (ctx.request.hasBody) {
    try {
      const body = ctx.request.body();
      if (body.type === "json") {
        ctx.state.body = await body.value;
      }
    } catch (err) {
      console.error("Body parsing error:", err);
    }
  }
  await next();
});

// Генератор ID
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Эндпоинт для рекламных сетей
router.get("/reward", async (ctx) => {
  const params = ctx.request.url.searchParams;
  const telegramId = params.get("userid");
  const secret = params.get("secret");
  const adId = params.get("ad_id") || "unknown";
  const source = params.get("source") || "telegram";

  // Валидация входящих параметров
  if (!telegramId || !/^\d+$/.test(telegramId)) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid Telegram ID" };
    return;
  }

  if (secret !== CONFIG.SECRET_KEY) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Invalid secret" };
    return;
  }

  try {
    // Формируем user_id для Telegram пользователя
    const userId = `tg_${telegramId}`;
    const today = new Date().toISOString().split('T')[0];
    
    // Проверяем существование пользователя
    let { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("user_id", userId)
      .single();

    // Создаем нового пользователя если не найден
    if (userError || !user) {
      const newUser = {
        user_id: userId,
        balance: 0,
        total_views: 0,
        ref_code: `ref_${generateId()}`,
        ref_count: 0,
        ref_earnings: 0,
        created_at: new Date().toISOString()
      };

      const { error: insertError } = await supabase
        .from("users")
        .insert([newUser]);

      if (insertError) throw insertError;
      
      user = newUser;
    }

    // Получаем статистику просмотров
    let { data: view, error: viewError } = await supabase
      .from("views")
      .select("count")
      .eq("user_id", userId)
      .eq("date", today)
      .single();

    const dailyViews = view?.count || 0;

    // Проверка дневного лимита
    if (dailyViews >= CONFIG.DAILY_LIMIT) {
      ctx.response.status = 429;
      ctx.response.body = { success: false, error: "Daily limit reached" };
      return;
    }

    // Рассчет награды
    const totalViews = user.total_views + 1;
    let bonus = 0;

    if (totalViews % CONFIG.BONUS_THRESHOLD === 0) {
      bonus = CONFIG.BONUS_AMOUNT;
    }

    const reward = CONFIG.REWARD_PER_AD + bonus;
    const newBalance = user.balance + reward;

    // Обновляем данные
    const updateUser = supabase
      .from("users")
      .update({
        balance: newBalance,
        total_views: totalViews
      })
      .eq("user_id", userId);

    const upsertView = supabase
      .from("views")
      .upsert({
        user_id: userId,
        date: today,
        count: dailyViews + 1
      }, { onConflict: "user_id,date" });

    await Promise.all([updateUser, upsertView]);

    // Успешный ответ
    ctx.response.body = {
      success: true,
      user_id: userId,
      reward: reward,
      base_reward: CONFIG.REWARD_PER_AD,
      bonus_reward: bonus,
      balance: newBalance,
      views_today: dailyViews + 1,
      total_views: totalViews
    };

  } catch (error) {
    console.error("Reward processing error:", error);
    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      error: "Internal server error",
      details: error.message
    };
  }
});

// Регистрация нового пользователя
router.post("/register", async (ctx) => {
  const { refCode } = ctx.state.body || {};
  const userId = `user_${generateId()}`;
  
  try {
    const { error } = await supabase
      .from("users")
      .insert({
        user_id: userId,
        balance: 0,
        total_views: 0,
        ref_code: `ref_${generateId()}`,
        ref_count: 0,
        ref_earnings: 0,
        created_at: new Date().toISOString()
      });

    if (error) throw error;
    
    ctx.response.body = {
      success: true,
      userId,
      refCode: userId.substr(0, 8).toUpperCase()
    };
  } catch (error) {
    console.error("Registration error:", error);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Database error" };
  }
});

// Получение данных пользователя
router.get("/user/:userId", async (ctx) => {
  const userId = ctx.params.userId;
  
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("user_id", userId)
      .single();
    
    if (error || !user) {
      ctx.response.status = 404;
      ctx.response.body = { success: false, error: "User not found" };
      return;
    }
    
    ctx.response.body = { success: true, ...user };
  } catch (error) {
    console.error("User fetch error:", error);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Internal server error" };
  }
});

// Статистика просмотров
router.get("/views/:userId/:date", async (ctx) => {
  const { userId, date } = ctx.params;
  
  try {
    const { data: view, error } = await supabase
      .from("views")
      .select("count")
      .eq("user_id", userId)
      .eq("date", date)
      .single();

    ctx.response.body = { 
      success: true, 
      views: view?.count || 0 
    };
  } catch (error) {
    console.error("Views fetch error:", error);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Internal server error" };
  }
});

// Заявка на вывод средств
router.post("/withdraw", async (ctx) => {
  const { userId, wallet, amount } = ctx.state.body || {};
  
  if (!userId || !wallet || !amount) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Missing parameters" };
    return;
  }

  try {
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("balance")
      .eq("user_id", userId)
      .single();

    if (userError || !user) {
      ctx.response.status = 404;
      ctx.response.body = { success: false, error: "User not found" };
      return;
    }

    if (amount < CONFIG.MIN_WITHDRAW || user.balance < amount) {
      ctx.response.status = 400;
      ctx.response.body = { success: false, error: "Invalid withdrawal amount" };
      return;
    }

    const withdrawId = `wd_${generateId()}`;
    
    const { error: withdrawError } = await supabase
      .from("withdrawals")
      .insert({
        withdrawal_id: withdrawId,
        user_id: userId,
        amount,
        wallet,
        status: "pending"
      });

    if (withdrawError) throw withdrawError;

    // Обновляем баланс
    await supabase
      .from("users")
      .update({ balance: user.balance - amount })
      .eq("user_id", userId);

    ctx.response.body = { success: true, withdrawId };
  } catch (error) {
    console.error("Withdrawal error:", error);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Internal server error" };
  }
});

// Получение списка заданий
router.get("/tasks", async (ctx) => {
  try {
    const { data: tasks, error } = await supabase
      .from("tasks")
      .select("*");
    
    if (error) throw error;
    
    ctx.response.body = { success: true, tasks };
  } catch (error) {
    console.error("Tasks fetch error:", error);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Internal server error" };
  }
});

// Завершение задания
router.post("/user/:userId/complete-task", async (ctx) => {
  const userId = ctx.params.userId;
  const { taskId } = ctx.state.body || {};
  
  if (!taskId) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Task ID is required" };
    return;
  }

  try {
    // Получаем данные пользователя
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (userError || !user) {
      ctx.response.status = 404;
      ctx.response.body = { success: false, error: "User not found" };
      return;
    }

    // Получаем данные задания
    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .select("*")
      .eq("task_id", taskId)
      .single();

    if (taskError || !task) {
      ctx.response.status = 404;
      ctx.response.body = { success: false, error: "Task not found" };
      return;
    }

    // Обновляем баланс
    const newBalance = user.balance + task.reward;
    await supabase
      .from("users")
      .update({ balance: newBalance })
      .eq("user_id", userId);

    ctx.response.body = {
      success: true,
      balance: newBalance,
      reward: task.reward
    };
  } catch (error) {
    console.error("Task completion error:", error);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Internal server error" };
  }
});

// Админ-авторизация
router.post("/admin/login", async (ctx) => {
  const { password } = ctx.state.body || {};
  
  if (password === CONFIG.ADMIN_PASSWORD) {
    ctx.response.body = { 
      success: true, 
      token: "admin_" + generateId() 
    };
  } else {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Wrong password" };
  }
});

// Получение заявок на вывод (админ)
router.get("/admin/withdrawals", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  try {
    const { data: withdrawals, error } = await supabase
      .from("withdrawals")
      .select("*")
      .order("date", { ascending: false });
    
    if (error) throw error;
    
    ctx.response.body = { success: true, withdrawals };
  } catch (error) {
    console.error("Withdrawals fetch error:", error);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Internal server error" };
  }
});

// Обновление статуса вывода (админ)
router.post("/admin/withdrawals/:id", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  const withdrawId = ctx.params.id;
  const { status } = ctx.state.body || {};
  
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  try {
    await supabase
      .from("withdrawals")
      .update({ status })
      .eq("withdrawal_id", withdrawId);
    
    ctx.response.body = { success: true };
  } catch (error) {
    console.error("Withdrawal update error:", error);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Internal server error" };
  }
});

// Управление заданиями (админ)
router.get("/admin/tasks", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  try {
    const { data: tasks, error } = await supabase
      .from("tasks")
      .select("*");
    
    if (error) throw error;
    
    ctx.response.body = { success: true, tasks };
  } catch (error) {
    console.error("Tasks fetch error:", error);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Internal server error" };
  }
});

// Добавление задания (админ)
router.post("/admin/tasks", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  const { title, reward, description, url, cooldown } = ctx.state.body || {};
  
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  try {
    const taskId = `task_${generateId()}`;
    const { error } = await supabase
      .from("tasks")
      .insert({
        task_id: taskId,
        title,
        reward,
        description,
        url,
        cooldown
      });
    
    if (error) throw error;
    
    ctx.response.body = { success: true, taskId };
  } catch (error) {
    console.error("Task creation error:", error);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Internal server error" };
  }
});

// Удаление задания (админ)
router.delete("/admin/tasks/:id", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  const taskId = ctx.params.id;
  
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  try {
    await supabase
      .from("tasks")
      .delete()
      .eq("task_id", taskId);
    
    ctx.response.body = { success: true };
  } catch (error) {
    console.error("Task deletion error:", error);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Internal server error" };
  }
});

// Корневой эндпоинт
router.get("/", (ctx) => {
  ctx.response.body = {
    success: true,
    message: "AdRewards API Server",
    version: "1.0",
    endpoints: [
      "/reward?userid=TELEGRAM_ID&secret=SECRET",
      "/register",
      "/user/:userId",
      "/withdraw",
      "/tasks"
    ]
  };
});

app.use(router.routes());
app.use(router.allowedMethods());

// Обработка 404
app.use((ctx) => {
  ctx.response.status = 404;
  ctx.response.body = { success: false, error: "Endpoint not found" };
});

// Запуск сервера
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
