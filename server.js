import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateWebAppData } from "https://deno.land/x/telegram_webapp@v1.0.0/mod.ts";

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
  REWARD_URL: "https://test.adsgram.ai/reward?userid=[userId]",
  BOT_TOKEN: "8178465909:AAFaHnIfv1Wyt3PIkT0B64vKEEoJOS9mkt4"
};

const supabase = createClient(
  "https://ibnxrjoxhjpmkjwzpngw.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlibnhyam94aGpwbWtqd3pwbmd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ2NTExNzEsImV4cCI6MjA3MDIyNzE3MX0.9OMEfH5wyakx7iCrZNiw-udkunrdF8kakZRzKvs7Xus"
);

const app = new Application();
const router = new Router();

// Валидация данных Telegram
function verifyTelegramData(initData) {
  return validateWebAppData(CONFIG.BOT_TOKEN, initData);
}

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
  return Math.floor(10000000 + Math.random() * 90000000);
}

async function getTotalViews(userId) {
  const { data, error } = await supabase
    .from("views")
    .select("count")
    .eq("user_id", userId);

  if (error) {
    console.error("Error getting total views:", error);
    return 0;
  }

  return data.reduce((sum, row) => sum + row.count, 0);
}

async function cleanupOldData() {
  try {
    await supabase
      .from("views")
      .delete()
      .lt("date", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);

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

// ================== ROUTES ================== //

// Точка входа для WebApp
router.get("/webapp", (ctx) => {
  ctx.response.headers.set("Content-Type", "text/html");
  ctx.response.body = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AdRewards PRO</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    body { background: #0c1a12; color: white; text-align: center; padding: 50px; }
    .loader { 
      border: 16px solid #1a2e22; 
      border-top: 16px solid #3d9970; 
      border-radius: 50%; 
      width: 120px; 
      height: 120px; 
      animation: spin 2s linear infinite; 
      margin: 0 auto; 
    }
    @keyframes spin { 
      0% { transform: rotate(0deg); } 
      100% { transform: rotate(360deg); } 
    }
  </style>
</head>
<body>
  <div class="loader"></div>
  <p>Загрузка приложения...</p>
  <script>
    // Получаем данные от Telegram
    const initData = new URLSearchParams(window.location.hash.substring(1));
    const tgParams = Object.fromEntries(initData.entries());
    
    // Проверяем и перенаправляем
    fetch('/verify-telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tgParams)
    })
    .then(response => response.json())
    .then(data => {
      if (data.success) {
        // Перенаправляем с параметрами пользователя
        window.location.href = \`/?tg_user=\${encodeURIComponent(JSON.stringify(data.user))}\`;
      } else {
        document.body.innerHTML = '<h2>Ошибка авторизации</h2><p>Попробуйте перезапустить приложение</p>';
      }
    });
  </script>
</body>
</html>`;
});

// Проверка данных Telegram
router.post("/verify-telegram", async (ctx) => {
  const data = await ctx.request.body().value;
  
  // Преобразуем данные в строку для проверки
  const initDataString = new URLSearchParams(data).toString();
  
  if (!verifyTelegramData(initDataString)) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Invalid Telegram data" };
    return;
  }
  
  const user = data.user ? JSON.parse(data.user) : {};
  ctx.response.body = {
    success: true,
    user: {
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      username: user.username
    }
  };
});

router.post("/register", async (ctx) => {
  const body = ctx.state.body || {};
  const refCode = body.refCode;
  const telegramId = body.telegramId;
  
  if (!telegramId) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Telegram ID is required" };
    return;
  }

  // Режим тестирования
  if (telegramId.startsWith("TEST")) {
    ctx.response.body = {
      success: true,
      userId: telegramId,
      refCode: "TESTREF",
      balance: 1.234,
      referrals: 3,
      refEarnings: 0.45
    };
    return;
  }

  // Проверяем существующего пользователя
  const { data: existingUser, error: existingError } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", telegramId)
    .single();

  if (existingUser) {
    ctx.response.body = {
      success: true,
      userId: telegramId,
      refCode: existingUser.ref_code,
      message: "User already exists"
    };
    return;
  }

  const userRefCode = generateId().toString();

  const { error } = await supabase
    .from("users")
    .insert({
      user_id: telegramId,
      balance: 0,
      ref_code: userRefCode,
      ref_count: 0,
      ref_earnings: 0,
      created_at: new Date().toISOString()
    });

  if (error) {
    console.error("Registration error:", error);
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false, 
      error: "Database error",
      details: error.message
    };
    return;
  }

  if (refCode) {
    const { data: referrer, error: refError } = await supabase
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
    userId: telegramId,
    refCode: userRefCode,
    refLink: `https://t.me/Ad_Rew_ards_bot?start=${userRefCode}`
  };
});

router.all("/reward", async (ctx) => {
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

  // Рассчитываем бонус за накопленные просмотры
  const totalViews = await getTotalViews(userId);
  const newTotalViews = totalViews + 1;
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
      balance: newBalance
    })
    .eq("user_id", userId);

  if (viewError || userUpdateError) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Database update failed" };
    return;
  }

  // Отправка reward event
  try {
    if (CONFIG.REWARD_URL) {
      const rewardUrl = CONFIG.REWARD_URL.replace("[userId]", userId);
      console.log(`Sending reward event to: ${rewardUrl}`);
      
      const response = await fetch(rewardUrl);
      if (!response.ok) {
        console.warn(`Reward event failed: ${response.status} ${response.statusText}`);
      }
    }
  } catch (error) {
    console.error("Error sending reward event:", error);
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
  
  const totalViews = await getTotalViews(userId);
  const { data: completedTasks } = await supabase
    .from("completed_tasks")
    .select("task_id")
    .eq("user_id", userId);
  
  ctx.response.body = {
    success: true,
    ...user,
    total_views: totalViews,
    completedTasks: completedTasks?.map(t => t.task_id) || []
  };
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
  const body = ctx.state.body || {};
  const userId = body.userId;
  const wallet = body.wallet;
  const amount = parseFloat(body.amount);
  
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
  const body = ctx.state.body || {};
  const taskId = body.taskId;
  
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
  const body = ctx.state.body || {};
  const password = body.password;
  
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

  const body = ctx.state.body || {};
  const status = body.status;
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

  const body = ctx.state.body || {};
  const title = body.title;
  const reward = parseFloat(body.reward);
  const description = body.description;
  const url = body.url;
  const cooldown = parseInt(body.cooldown) || 10;
  
  const taskId = `task_${generateId()}`;
  
  await supabase
    .from("tasks")
    .insert({
      task_id: taskId,
      title,
      reward,
      description,
      url,
      cooldown
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

  const body = ctx.state.body || {};
  const title = body.title;
  const reward = parseFloat(body.reward);
  const description = body.description;
  const url = body.url;
  const cooldown = parseInt(body.cooldown) || 10;
  
  const taskId = `custom_${generateId()}`;
  
  await supabase
    .from("custom_tasks")
    .insert({
      task_id: taskId,
      title,
      reward,
      description,
      url,
      cooldown
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
    message: "Ad Rewards Server with Supabase"
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
