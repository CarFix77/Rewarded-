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
  ADMIN_PASSWORD: "8223Nn8223"
};

// Инициализация Supabase
const supabase = createClient(
  "https://ibnxrjoxhjpmkjwzpngw.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlibnhyam94aGpwbWtqd3pwbmd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ2NTExNzEsImV4cCI6MjA3MDIyNzE3MX0.9OMEfH5wyakx7iCrZNiw-udkunrdF8kakZRzKvs7Xus"
);

const app = new Application();
const router = new Router();

// ================== MIDDLEWARES ================== //
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

// ================== HELPERS ================== //
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

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

setInterval(cleanupOldData, 24 * 60 * 60 * 1000);
cleanupOldData();

// ================== ROUTES ================== //
router.post("/register", async (ctx) => {
  const { refCode } = ctx.state.body || {};
  const userId = `user_${generateId()}`;
  const userRefCode = generateId().toString();

  // Создаем пользователя
  const { error } = await supabase
    .from("users")
    .insert({
      user_id: userId,
      balance: 0,
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

  // Обработка реферала
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

  // Получаем пользователя и сегодняшние просмотры
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

  const newBalance = user.balance + CONFIG.REWARD_PER_AD;
  
  // Обновляем счетчик просмотров
  const { error: viewError } = await supabase
    .from("views")
    .upsert({
      user_id: userId,
      date: today,
      count: dailyViews + 1
    }, { onConflict: "user_id,date" });

  // Обновляем баланс
  const { error: userUpdateError } = await supabase
    .from("users")
    .update({ balance: newBalance })
    .eq("user_id", userId);

  if (viewError || userUpdateError) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Database update failed" };
    return;
  }

  ctx.response.body = {
    success: true,
    reward: CONFIG.REWARD_PER_AD,
    balance: newBalance,
    viewsToday: dailyViews + 1
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
  
  // Получаем выполненные задания
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
  
  // Проверка данных
  if (!userId || !wallet || !amount) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Missing parameters" };
    return;
  }

  // Проверяем пользователя
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

  // Проверяем сумму
  if (amount < CONFIG.MIN_WITHDRAW || user.balance < amount) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid withdrawal amount" };
    return;
  }

  // Создаем запрос на вывод
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

  // Обновляем баланс
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

  ctx.response.body = {
    success: true,
    tasks: [...(tasks || []), ...(customTasks || [])]
  };
});

router.post("/user/:userId/complete-task", async (ctx) => {
  const userId = ctx.params.userId;
  const { taskId } = ctx.state.body || {};
  
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
  
  if (!taskId) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Task ID is required" };
    return;
  }
  
  // Проверяем, выполнено ли задание
  const { data: completedTask, error: completedError } = await supabase
    .from("completed_tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("task_id", taskId)
    .single();

  if (completedTask) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Task already completed" };
    return;
  }
  
  // Получаем информацию о задании
  let task = null;
  
  const { data: taskData, error: taskError } = await supabase
    .from("tasks")
    .select("*")
    .eq("task_id", taskId)
    .single();

  if (!taskError && taskData) {
    task = taskData;
  } else {
    const { data: customTaskData, error: customTaskError } = await supabase
      .from("custom_tasks")
      .select("*")
      .eq("task_id", taskId)
      .single();
      
    if (customTaskData) {
      task = customTaskData;
    }
  }
  
  if (!task) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Task not found" };
    return;
  }
  
  // Добавляем в выполненные задания
  await supabase
    .from("completed_tasks")
    .insert({
      user_id: userId,
      task_id: taskId,
      completed_at: new Date().toISOString()
    });
  
  // Обновляем баланс
  const newBalance = user.balance + task.reward;
  await supabase
    .from("users")
    .update({ balance: newBalance })
    .eq("user_id", userId);
  
  ctx.response.body = {
    success: true,
    balance: newBalance
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
