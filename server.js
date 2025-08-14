import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  WEBHOOK_SECRET: "wagner1080",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223",
  BONUS_THRESHOLD: 200,    // Каждые 200 просмотров
  BONUS_AMOUNT: 0.005,     // Награда за каждые 200 просмотров
  BOT_TOKEN: "8178465909:AAFaHnIfv1Wyt3PIkT0B64vKEEoJOS9mkt4" // Ваш токен бота
};

const supabase = createClient(
  "https://ibnxrjoxhjpmkjwzpngw.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlibnhyam94aGpwbWtqd3pwbmd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ2NTExNzEsImV4cCI6MjA3MDIyNzE3MX0.9OMEfH5wyakx7iCrZNiw-udkunrdF8kakZRzKvs7Xus"
);

const app = new Application();
const router = new Router();

app.use(async (ctx, next) => {
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

app.use(oakCors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

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

function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

async function cleanupOldData() {
  try {
    await supabase
      .from("views")
      .delete()
      .lt("date", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    const { data: inactiveUsers } = await supabase
      .from("users")
      .select("user_id")
      .lt("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .lt("balance", 0.01);

    if (inactiveUsers && inactiveUsers.length > 0) {
      const userIds = inactiveUsers.map(u => u.user_id);
      
      await supabase
        .from("views")
        .delete()
        .in("user_id", userIds);
      
      await supabase
        .from("users")
        .delete()
        .in("user_id", userIds);
    }

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

setInterval(cleanupOldData, 24 * 60 * 60 * 1000);
cleanupOldData();

// ================== TELEGRAM AUTHENTICATION ================== //

router.post("/telegram-auth", async (ctx) => {
  const { initData } = ctx.state.body || {};
  
  if (!initData) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "initData is required" };
    return;
  }

  // Валидация данных Telegram
  const isValid = await validateTelegramData(initData, CONFIG.BOT_TOKEN);
  if (!isValid) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Invalid Telegram data" };
    return;
  }

  // Парсинг данных пользователя
  const params = new URLSearchParams(initData);
  const userJson = params.get('user');
  if (!userJson) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "User data not found" };
    return;
  }

  let userData;
  try {
    userData = JSON.parse(userJson);
  } catch (e) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid user data" };
    return;
  }

  const telegramId = userData.id;
  if (!telegramId) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Telegram ID not found" };
    return;
  }

  // Поиск или создание пользователя
  const { data: existingUser, error: userError } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegramId)
    .single();

  let userId;
  if (userError || !existingUser) {
    // Создаем нового пользователя
    userId = `user_${generateId()}`;
    const refCode = generateId().toString();
    
    const { error: insertError } = await supabase
      .from("users")
      .insert({
        user_id: userId,
        telegram_id: telegramId,
        telegram_username: userData.username || "",
        first_name: userData.first_name || "",
        last_name: userData.last_name || "",
        telegram_data: userData,
        balance: 0,
        total_views: 0,
        ref_code: refCode,
        ref_count: 0,
        ref_earnings: 0,
        created_at: new Date().toISOString()
      });

    if (insertError) {
      console.error("Error creating user:", insertError);
      ctx.response.status = 500;
      ctx.response.body = { success: false, error: "Database error" };
      return;
    }
  } else {
    userId = existingUser.user_id;
  }

  // Обновляем данные пользователя
  await supabase
    .from("users")
    .update({
      telegram_username: userData.username || "",
      first_name: userData.first_name || "",
      last_name: userData.last_name || "",
      telegram_data: userData
    })
    .eq("user_id", userId);

  ctx.response.body = {
    success: true,
    userId,
    telegramId,
    userData
  };
});

// Функция валидации данных Telegram
async function validateTelegramData(initData: string, botToken: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  
  if (!hash) return false;
  params.delete('hash');
  
  // Сортировка параметров
  const sortedKeys = Array.from(params.keys()).sort();
  const dataCheckString = sortedKeys.map(k => `${k}=${params.get(k)}`).join('\n');
  
  // Генерация секретного ключа
  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"]
  );
  
  const secret = new Uint8Array(
    await crypto.subtle.sign("HMAC", secretKey, encoder.encode(botToken))
  );
  
  // Проверка подписи
  const signingKey = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"]
  );
  
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", signingKey, encoder.encode(dataCheckString))
  );
  
  const signatureHex = Array.from(signature)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  return signatureHex === hash;
}

// ================== ROUTES ================== //

router.post("/register", async (ctx) => {
  const { refCode, telegramId } = ctx.state.body || {};
  const userId = `user_${generateId()}`;
  const userRefCode = generateId().toString();

  const userData = {
    user_id: userId,
    balance: 0,
    total_views: 0,
    ref_code: userRefCode,
    ref_count: 0,
    ref_earnings: 0,
    created_at: new Date().toISOString()
  };

  // Если есть Telegram ID, добавляем его
  if (telegramId) {
    userData.telegram_id = telegramId;
  }

  const { error } = await supabase
    .from("users")
    .insert(userData);

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

router.all("/reward", async (ctx) => {
  let userId, secret;
  const body = ctx.state.body || {};
  
  if (ctx.request.method === "POST") {
    userId = body.userId || body.userid;
    secret = body.secret;
  } else {
    const urlParams = ctx.request.url.searchParams;
    userId = urlParams.get("userid");
    secret = urlParams.get("secret");
  }

  // Если передан telegramId вместо userId
  if (!userId && body.telegramId) {
    const { data: user } = await supabase
      .from("users")
      .select("user_id")
      .eq("telegram_id", body.telegramId)
      .single();
      
    if (user) {
      userId = user.user_id;
    }
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

  // Рассчитываем бонус за накопленные просмотры
  const newTotalViews = (user.total_views || 0) + 1;
  let bonusReward = 0;
  
  if (newTotalViews % CONFIG.BONUS_THRESHOLD === 0) {
    bonusReward = CONFIG.BONUS_AMOUNT;
    console.log(`Начисление бонуса за ${CONFIG.BONUS_THRESHOLD} просмотров: $${CONFIG.BONUS_AMOUNT}`);
  }

  const totalReward = CONFIG.REWARD_PER_AD + bonusReward;
  const newBalance = user.balance + totalReward;
  
  // Обновляем данные
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
    baseReward: CONFIG.REWARD_PER_AD,
    bonusReward: bonusReward,
    balance: newBalance,
    viewsToday: dailyViews + 1,
    totalViews: newTotalViews
  };
});

router.get("/user/:userId", async (ctx) => {
  const userId = ctx.params.userId;
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
  
  const { data: completedTasks } = await supabase
    .from("completed_tasks")
    .select("task_id")
    .eq("user_id", userId);
  
  ctx.response.body = {
    success: true,
    ...user,
    completedTasks: completedTasks?.map(t => t.task_id) || []
  };
});

router.get("/user-by-telegram/:telegramId", async (ctx) => {
  const telegramId = ctx.params.telegramId;
  
  const { data: user, error } = await supabase
    .from("users")
    .select("user_id, balance, total_views, ref_code")
    .eq("telegram_id", telegramId)
    .single();
  
  if (error || !user) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "User not found" };
    return;
  }
  
  ctx.response.body = {
    success: true,
    userId: user.user_id,
    balance: user.balance,
    totalViews: user.total_views,
    refCode: user.ref_code
  };
});

router.post("/update-telegram-data", async (ctx) => {
  const { userId, userData } = ctx.state.body || {};
  
  if (!userId || !userData) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Missing parameters" };
    return;
  }

  const updateData = {
    telegram_username: userData.username || "",
    first_name: userData.first_name || "",
    last_name: userData.last_name || "",
    telegram_data: userData
  };

  if (userData.id) {
    updateData.telegram_id = userData.id;
  }

  const { error } = await supabase
    .from("users")
    .update(updateData)
    .eq("user_id", userId);

  if (error) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Update failed" };
    return;
  }

  ctx.response.body = { success: true };
});

router.get("/views/:userId/:date", async (ctx) => {
  const { userId, date } = ctx.params;
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
});

router.post("/withdraw", async (ctx) => {
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
    status: "pending"
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

router.get("/tasks", async (ctx) => {
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

  // Добавляем системное задание для просмотров
  const adWatchTask = {
    task_id: "system_ad_watching",
    title: "Просмотр рекламы",
    description: "Смотрите рекламные ролики и получайте вознаграждение",
    reward: 0,
    url: "#",
    cooldown: 0,
    is_system: true
  };

  ctx.response.body = {
    success: true,
    tasks: [...(tasks || []), ...(customTasks || []), adWatchTask]
  };
});

router.post("/user/:userId/complete-task", async (ctx) => {
  const userId = ctx.params.userId;
  const { taskId } = ctx.state.body || {};
  
  console.log(`Complete task request: user=${userId}, task=${taskId}`);
  
  // 1. Verify user exists
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", userId)
    .single();
  
  if (userError || !user) {
    console.error("User not found:", userId);
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "User not found" };
    return;
  }
  
  if (!taskId) {
    console.error("Task ID missing");
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Task ID is required" };
    return;
  }
  
  // 2. Try to record task completion (will fail if already completed)
  try {
    const { error } = await supabase
      .from("completed_tasks")
      .insert({
        user_id: userId,
        task_id: taskId,
        completed_at: new Date().toISOString()
      });

    if (error) {
      if (error.code === "23505") { // Unique violation
        console.log("Task already completed:", taskId);
        ctx.response.status = 400;
        ctx.response.body = { success: false, error: "Task already completed" };
        return;
      }
      throw error;
    }
  } catch (error) {
    console.error("Task completion record error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false, 
      error: "Failed to record task completion" 
    };
    return;
  }
  
  // 3. Find task in database
  let task = null;
  
  // Check main tasks
  const { data: taskData } = await supabase
    .from("tasks")
    .select("*")
    .eq("task_id", taskId)
    .maybeSingle();

  if (taskData) {
    task = taskData;
  } 
  // Check custom tasks
  else {
    const { data: customTaskData } = await supabase
      .from("custom_tasks")
      .select("*")
      .eq("task_id", taskId)
      .maybeSingle();
      
    if (customTaskData) {
      task = customTaskData;
    }
  }
  
  if (!task) {
    console.error("Task not found:", taskId);
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Task not found" };
    return;
  }
  
  // 4. Award task reward
  const newBalance = user.balance + task.reward;
  const { error: balanceError } = await supabase
    .from("users")
    .update({ balance: newBalance })
    .eq("user_id", userId);

  if (balanceError) {
    console.error("Balance update error:", balanceError);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Balance update failed" };
    return;
  }
  
  console.log(`Task completed: user=${userId}, task=${taskId}, reward=$${task.reward}`);
  
  ctx.response.body = {
    success: true,
    balance: newBalance,
    reward: task.reward
  };
});

// ================== ADMIN ROUTES ================== //

router.post("/admin/login", async (ctx) => {
  const { password } = ctx.state.body || {};
  if (password === CONFIG.ADMIN_PASSWORD) {
    ctx.response.body = { success: true, token: "admin_" + generateId() };
  } else {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Wrong password" };
  }
});

router.get("/admin/withdrawals", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  const { data: withdrawals, error } = await supabase
    .from("withdrawals")
    .select("*")
    .order("date", { ascending: false });

  ctx.response.body = { success: true, withdrawals };
});

router.post("/admin/withdrawals/:id", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  const { status } = ctx.state.body || {};
  const withdrawalId = ctx.params.id;

  await supabase
    .from("withdrawals")
    .update({
      status,
      processed_at: new Date().toISOString()
    })
    .eq("withdrawal_id", withdrawalId);

  ctx.response.body = { success: true };
});

router.get("/admin/tasks", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  const { data: tasks, error } = await supabase
    .from("tasks")
    .select("*");

  ctx.response.body = { success: true, tasks };
});

router.post("/admin/tasks", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  const { title, reward, description, url, cooldown } = ctx.state.body || {};
  const taskId = `task_${generateId()}`;
  
  await supabase
    .from("tasks")
    .insert({
      task_id: taskId,
      title,
      reward: parseFloat(reward),
      description,
      url,
      cooldown: parseInt(cooldown) || 10
    });
  
  ctx.response.body = { success: true, taskId };
});

router.delete("/admin/tasks/:id", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  await supabase
    .from("tasks")
    .delete()
    .eq("task_id", ctx.params.id);

  ctx.response.body = { success: true };
});

router.get("/admin/custom-tasks", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  const { data: tasks, error } = await supabase
    .from("custom_tasks")
    .select("*");

  ctx.response.body = { success: true, tasks };
});

router.post("/admin/custom-tasks", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  const { title, reward, description, url, cooldown } = ctx.state.body || {};
  const taskId = `custom_${generateId()}`;
  
  await supabase
    .from("custom_tasks")
    .insert({
      task_id: taskId,
      title,
      reward: parseFloat(reward),
      description,
      url,
      cooldown: parseInt(cooldown) || 10
    });
  
  ctx.response.body = { success: true, taskId };
});

router.delete("/admin/custom-tasks/:id", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  await supabase
    .from("custom_tasks")
    .delete()
    .eq("task_id", ctx.params.id);

  ctx.response.body = { success: true };
});

// ================== SERVER SETUP ================== //

router.get("/", (ctx) => {
  ctx.response.body = {
    success: true,
    status: "OK",
    version: "1.0",
    message: "Ad Rewards Server with Supabase and Telegram"
  };
});

app.use(router.routes());
app.use(router.allowedMethods());

app.use((ctx) => {
  ctx.response.status = 404;
  ctx.response.body = { success: false, error: "Endpoint not found" };
});

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
