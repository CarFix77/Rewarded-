import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Bot } from "https://deno.land/x/grammy@v1.20.3/mod.ts";

// Конфигурация
const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: Deno.env.get("SECRET_KEY") || "wagner46375",
  WEBHOOK_SECRET: Deno.env.get("WEBHOOK_SECRET") || "wagner1080",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: Deno.env.get("ADMIN_PASSWORD") || "8223Nn8223",
  BONUS_THRESHOLD: 200,
  BONUS_AMOUNT: 0.005,
  FRONTEND_URL: "https://carfix77.github.io/Rewarded-"
};

// Инициализация клиентов
const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "https://ibnxrjoxhjpmkjwzpngw.supabase.co",
  Deno.env.get("SUPABASE_KEY") || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
);

const app = new Application();
const router = new Router();
const bot = new Bot(Deno.env.get("BOT_TOKEN") || "8178465909:AAFaHnIfv1Wyt3PIkT0B64vKEEoJOS9mkt4");

// Middleware
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error("Error:", err);
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: err.message };
  }
});

app.use(oakCors({
  origin: CONFIG.FRONTEND_URL,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(async (ctx, next) => {
  if (ctx.request.hasBody) {
    try {
      const body = ctx.request.body();
      ctx.state.body = body.type === "json" ? await body.value : 
                      body.type === "form" ? Object.fromEntries((await body.value).entries()) : 
                      null;
    } catch (err) {
      console.error("Body parse error:", err);
    }
  }
  await next();
});

// Вспомогательные функции
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

async function cleanupOldData() {
  try {
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    await supabase.from("views").delete().lt("date", weekAgo);
    
    const { data: inactiveUsers } = await supabase
      .from("users")
      .select("user_id")
      .lt("created_at", new Date(Date.now() - 30 * 864e5).toISOString())
      .lt("balance", 0.01);

    if (inactiveUsers?.length) {
      const ids = inactiveUsers.map(u => u.user_id);
      await supabase.from("views").delete().in("user_id", ids);
      await supabase.from("users").delete().in("user_id", ids);
    }

    await supabase
      .from("withdrawals")
      .delete()
      .lt("date", weekAgo)
      .neq("status", "pending");
  } catch (error) {
    console.error("Cleanup failed:", error);
  }
}

// Telegram Bot
bot.command("start", async (ctx) => {
  const userId = `tg_${ctx.from.id}`;
  const userRefCode = generateId().toString();

  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!user) {
    await supabase.from("users").insert({
      user_id: userId,
      balance: 0,
      total_views: 0,
      ref_code: userRefCode,
      ref_count: 0,
      ref_earnings: 0,
      created_at: new Date().toISOString()
    });
  }

  await ctx.reply("👋 Добро пожаловать! Откройте приложение:", {
    reply_markup: {
      inline_keyboard: [[{
        text: "Открыть Rewarded",
        web_app: { url: `${CONFIG.FRONTEND_URL}?userId=${userId}` }
      }]]
    }
  });
});

// API Endpoints
router.post("/register", async (ctx) => {
  const { refCode } = ctx.state.body || {};
  const userId = `user_${generateId()}`;
  const userRefCode = generateId().toString();

  const { error } = await supabase.from("users").insert({
    user_id: userId,
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
  
  try {
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
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Failed to record task completion" };
    return;
  }
  
  let task = null;
  const { data: taskData } = await supabase
    .from("tasks")
    .select("*")
    .eq("task_id", taskId)
    .maybeSingle();

  if (!taskData) {
    const { data: customTaskData } = await supabase
      .from("custom_tasks")
      .select("*")
      .eq("task_id", taskId)
      .maybeSingle();
    task = customTaskData;
  } else {
    task = taskData;
  }
  
  if (!task) {
    ctx.response.status = 404;
    ctx.response.body = { success: false, error: "Task not found" };
    return;
  }
  
  const newBalance = user.balance + task.reward;
  const { error: balanceError } = await supabase
    .from("users")
    .update({ balance: newBalance })
    .eq("user_id", userId);

  if (balanceError) {
    ctx.response.status = 500;
    ctx.response.body = { success: false, error: "Balance update failed" };
    return;
  }
  
  ctx.response.body = {
    success: true,
    balance: newBalance,
    reward: task.reward
  };
});

// Admin Endpoints
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

  ctx.response.body = { success: !error, withdrawals: withdrawals || [] };
});

router.post("/admin/withdrawals/:id", async (ctx) => {
  const authHeader = ctx.request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Unauthorized" };
    return;
  }

  const { status } = ctx.state.body || {};
  await supabase
    .from("withdrawals")
    .update({ status, processed_at: new Date().toISOString() })
    .eq("withdrawal_id", ctx.params.id);

  ctx.response.body = { success: true };
});

// Server Initialization
const port = parseInt(Deno.env.get("PORT") || "8000");
const WEBHOOK_URL = `${CONFIG.FRONTEND_URL}/telegram-webhook`;

// Setup cleanup job
setInterval(cleanupOldData, 864e5);
cleanupOldData();

// Configure webhook in production
if (Deno.env.get("DENO_ENV") === "production") {
  try {
    await bot.api.setWebhook(WEBHOOK_URL);
    console.log(`Webhook configured for ${WEBHOOK_URL}`);
  } catch (err) {
    console.error("Webhook setup failed:", err);
  }
} else {
  bot.start();
  console.log("Bot running in polling mode");
}

// Start server
app.use(router.routes());
app.use(router.allowedMethods());

app.use((ctx) => {
  ctx.response.status = 404;
  ctx.response.body = { success: false, error: "Not Found" };
});

console.log(`Server running on port ${port}`);
await app.listen({ port });
