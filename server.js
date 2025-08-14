import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHash } from "node:crypto";

// Конфигурация
const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  WEBHOOK_SECRET: "wagner1080",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223",
  BONUS_THRESHOLD: 200,
  BONUS_AMOUNT: 0.005,
  BOT_TOKEN: "8178465909:AAFaHnIfv1Wyt3PIkT0B64vKEEoJOS9mkt4",
  SUPABASE_URL: "https://ibnxrjoxhjpmkjwzpngw.supabase.co",
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlibnhyam94aGpwbWtqd3pwbmd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ2NTExNzEsImV4cCI6MjA3MDIyNzE3MX0.9OMEfH5wyakx7iCrZNiw-udkunrdF8kakZRzKvs7Xus",
  API_PREFIX: "/api"
};

// Инициализация Supabase
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

const app = new Application();
const router = new Router();

// Middleware
app.use(async (ctx, next) => {
  console.log(`[${new Date().toISOString()}] ${ctx.request.method} ${ctx.request.url.pathname}`);
  try {
    await next();
  } catch (err) {
    console.error("Server error:", err);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false, 
      error: "Internal server error",
      details: err.message 
    };
  }
});

// CORS
app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Парсинг тела запроса
app.use(async (ctx, next) => {
  if (ctx.request.hasBody) {
    try {
      const body = ctx.request.body();
      if (body.type === "json") {
        ctx.state.body = await body.value;
      } else if (body.type === "form") {
        const formData = await body.value;
        ctx.state.body = Object.fromEntries(formData.entries());
      }
    } catch (err) {
      console.error("Body parsing error:", err);
    }
  }
  await next();
});

// Валидация данных Telegram
function validateTelegramData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    
    const dataToCheck = Array.from(params.entries())
      .filter(([key]) => key !== 'hash')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = createHash('sha256')
      .update(CONFIG.BOT_TOKEN)
      .digest();
    
    const calculatedHash = createHash('sha256')
      .update(dataToCheck)
      .update(secretKey)
      .digest('hex');

    return calculatedHash === hash;
  } catch (error) {
    console.error("Telegram validation error:", error);
    return false;
  }
}

function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// ================== API РОУТЫ ================== //

// Health check
router.get(`${CONFIG.API_PREFIX}/health`, (ctx) => {
  ctx.response.body = { success: true, status: "OK", version: "1.0" };
});

// Telegram аутентификация
router.post(`${CONFIG.API_PREFIX}/telegram-auth`, async (ctx) => {
  const { initData } = ctx.state.body || {};
  
  if (!initData) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Telegram initData is required" };
    return;
  }

  if (!validateTelegramData(initData)) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Invalid Telegram data signature" };
    return;
  }

  try {
    const params = new URLSearchParams(initData);
    const userData = JSON.parse(params.get('user'));
    const userId = `tg_${userData.id}`;
    
    const { data: existingUser } = await supabase
      .from("users")
      .select("*")
      .eq("telegram_id", userData.id)
      .single();

    if (!existingUser) {
      const userRefCode = generateId().toString();
      const { error } = await supabase.from("users").insert({
        user_id: userId,
        telegram_id: userData.id,
        telegram_username: userData.username,
        first_name: userData.first_name,
        last_name: userData.last_name,
        telegram_data: userData,
        balance: 0,
        total_views: 0,
        ref_code: userRefCode,
        ref_count: 0,
        ref_earnings: 0,
        created_at: new Date().toISOString()
      });

      if (error) throw error;
    }

    ctx.response.body = {
      success: true,
      userId,
      telegramUser: userData
    };
  } catch (error) {
    console.error("Telegram auth error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false, 
      error: "Server error during Telegram auth",
      details: error.message 
    };
  }
});

// Регистрация пользователя
router.post(`${CONFIG.API_PREFIX}/register`, async (ctx) => {
  const { refCode, initData } = ctx.state.body || {};
  
  let userId, userRefCode, telegramId = null;
  
  if (initData && validateTelegramData(initData)) {
    const params = new URLSearchParams(initData);
    const userData = JSON.parse(params.get('user'));
    userId = `tg_${userData.id}`;
    telegramId = userData.id;
    userRefCode = generateId().toString();
  } else {
    userId = `user_${generateId()}`;
    userRefCode = generateId().toString();
  }

  const { error } = await supabase.from("users").insert({
    user_id: userId,
    telegram_id: telegramId,
    balance: 0,
    total_views: 0,
    ref_code: userRefCode,
    ref_count: 0,
    ref_earnings: 0,
    created_at: new Date().toISOString()
  });

  if (error) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Database error" };
    return;
  }

  if (refCode) {
    const { data: referrer } = await supabase
      .from("users")
      .select("*")
      .eq("ref_code", refCode)
      .single();

    if (referrer) {
      const bonus = CONFIG.REWARD_PER_AD * CONFIG.REFERRAL_PERCENT;
      await supabase
        .from("users")
        .update({
          ref_count: referrer.ref_count + 1,
          ref_earnings: referrer.ref_earnings + bonus,
          balance: referrer.balance + bonus
        })
        .eq("user_id", referrer.user_id);
    }
  }

  ctx.response.body = {
    success: true,
    userId,
    refCode: userRefCode,
    refLink: `https://t.me/Ad_Rew_ards_bot?start=${userRefCode}`
  };
});

// Награда за просмотр
router.all(`${CONFIG.API_PREFIX}/reward`, async (ctx) => {
  let userId, secret;
  
  if (ctx.request.method === "POST") {
    const body = ctx.state.body || {};
    userId = body.userId || body.userid;
    secret = body.secret;
  } else {
    userId = ctx.request.url.searchParams.get("userid");
    secret = ctx.request.url.searchParams.get("secret");
  }

  if (!userId) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "User ID is required" };
    return;
  }

  if (secret !== CONFIG.SECRET_KEY && secret !== CONFIG.WEBHOOK_SECRET) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Invalid secret" };
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  
  const [{ data: user, error: userError }, { data: viewsData, error: viewsError }] = await Promise.all([
    supabase.from("users").select("*").eq("user_id", userId).single(),
    supabase.from("views").select("count").eq("user_id", userId).eq("date", today).single()
  ]);

  if (userError || !user) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "User not found" };
    return;
  }

  const dailyViews = viewsData?.count || 0;
  if (dailyViews >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { success: false, error: "Daily limit reached" };
    return;
  }

  const newTotalViews = (user.total_views || 0) + 1;
  let bonusReward = 0;
  
  if (newTotalViews % CONFIG.BONUS_THRESHOLD === 0) {
    bonusReward = CONFIG.BONUS_AMOUNT;
  }

  const totalReward = CONFIG.REWARD_PER_AD + bonusReward;
  const newBalance = user.balance + totalReward;
  
  const { error: viewError } = await supabase
    .from("views")
    .upsert({
      user_id: userId,
      date: today,
      count: dailyViews + 1
    }, { onConflict: "user_id,date" });

  const { error: userUpdateError } = await supabase
    .from("users")
    .update({ 
      balance: newBalance,
      total_views: newTotalViews 
    })
    .eq("user_id", userId);

  if (viewError || userUpdateError) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Database update failed" };
    return;
  }

  ctx.response.body = {
    success: true,
    reward: totalReward,
    balance: newBalance,
    viewsToday: dailyViews + 1,
    totalViews: newTotalViews
  };
});

// Получение информации о пользователе
router.get(`${CONFIG.API_PREFIX}/user/:userId`, async (ctx) => {
  const userId = ctx.params.userId;
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .or(`user_id.eq.${userId},telegram_id.eq.${userId.replace('tg_', '')}`)
    .single();
  
  if (error || !user) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "User not found" };
    return;
  }
  
  const { data: completedTasks } = await supabase
    .from("completed_tasks")
    .select("task_id")
    .eq("user_id", user.user_id);
  
  ctx.response.body = {
    success: true,
    ...user,
    completedTasks: completedTasks?.map(t => t.task_id) || []
  };
});

// Вывод средств
router.post(`${CONFIG.API_PREFIX}/withdraw`, async (ctx) => {
  const { userId, wallet, amount } = ctx.state.body || {};
  
  if (!userId || !wallet || !amount) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Missing parameters" };
    return;
  }

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
  const { error: withdrawError } = await supabase.from("withdrawals").insert({
    withdrawal_id: withdrawId,
    user_id: userId,
    amount,
    wallet,
    status: "pending",
    date: new Date().toISOString()
  });

  if (withdrawError) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Withdrawal creation failed" };
    return;
  }

  await supabase
    .from("users")
    .update({ balance: user.balance - amount })
    .eq("user_id", userId);

  ctx.response.body = { success: true, withdrawId };
});

// Список заданий
router.get(`${CONFIG.API_PREFIX}/tasks`, async (ctx) => {
  const { data: tasks, error: tasksError } = await supabase
    .from("tasks")
    .select("*");
  
  const { data: customTasks, error: customTasksError } = await supabase
    .from("custom_tasks")
    .select("*");

  if (tasksError || customTasksError) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Database error" };
    return;
  }

  ctx.response.body = {
    success: true,
    tasks: [...(tasks || []), ...(customTasks || [])]
  };
});

// Завершение задания
router.post(`${CONFIG.API_PREFIX}/user/:userId/complete-task`, async (ctx) => {
  const userId = ctx.params.userId;
  const { taskId } = ctx.state.body || {};
  
  if (!taskId) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Task ID is required" };
    return;
  }
  
  try {
    let task = null;
    const { data: mainTask } = await supabase
      .from("tasks")
      .select("*")
      .eq("task_id", taskId)
      .maybeSingle();

    if (mainTask) {
      task = mainTask;
    } else {
      const { data: customTask } = await supabase
        .from("custom_tasks")
        .select("*")
        .eq("task_id", taskId)
        .maybeSingle();
      if (customTask) task = customTask;
    }

    if (!task) {
      ctx.response.status = 404;
      ctx.response.body = { success: false, error: "Task not found" };
      return;
    }

    const { error } = await supabase
      .from("completed_tasks")
      .insert({
        user_id: userId,
        task_id: taskId,
        completed_at: new Date().toISOString()
      });

    if (error?.code === "23505") {
      ctx.response.status = 400;
      ctx.response.body = { success: false, error: "Task already completed" };
      return;
    } else if (error) throw error;

    const { data: user } = await supabase
      .from("users")
      .select("balance")
      .eq("user_id", userId)
      .single();

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
    ctx.response.body = { 
      success: false, 
      error: "Failed to complete task",
      details: error.message 
    };
  }
});

// Очистка старых данных
async function cleanupOldData() {
  try {
    // Удаляем просмотры старше 7 дней
    await supabase
      .from("views")
      .delete()
      .lt("date", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    // Удаляем неактивных пользователей
    const { data: inactiveUsers } = await supabase
      .from("users")
      .select("user_id")
      .lt("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .lt("balance", 0.01);

    if (inactiveUsers?.length > 0) {
      const userIds = inactiveUsers.map(u => u.user_id);
      await supabase.from("views").delete().in("user_id", userIds);
      await supabase.from("users").delete().in("user_id", userIds);
    }

    // Удаляем старые выводы
    await supabase
      .from("withdrawals")
      .delete()
      .lt("date", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .neq("status", "pending");

    console.log("Cleanup completed");
  } catch (error) {
    console.error("Cleanup error:", error);
  }
}

// Запуск сервера
app.use(router.routes());
app.use(router.allowedMethods());

// Обработка 404 для API
app.use((ctx) => {
  if (ctx.request.url.pathname.startsWith(CONFIG.API_PREFIX)) {
    ctx.response.status = 404;
    ctx.response.body = { 
      success: false, 
      error: "Endpoint not found",
      availableEndpoints: [
        `${CONFIG.API_PREFIX}/health`,
        `${CONFIG.API_PREFIX}/telegram-auth`,
        `${CONFIG.API_PREFIX}/register`,
        `${CONFIG.API_PREFIX}/reward`,
        `${CONFIG.API_PREFIX}/user/:userId`,
        `${CONFIG.API_PREFIX}/withdraw`,
        `${CONFIG.API_PREFIX}/tasks`,
        `${CONFIG.API_PREFIX}/user/:userId/complete-task`
      ]
    };
  } else {
    ctx.response.status = 404;
    ctx.response.body = "Not Found";
  }
});

// Запуск очистки по расписанию
setInterval(cleanupOldData, 24 * 60 * 60 * 1000);
cleanupOldData();

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
