import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Конфигурация
const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  WEBHOOK_SECRET: "wagner1080",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223",
  SUPABASE_URL: "https://rdugiihkzwepswtilevn.supabase.co",
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkdWdpaWhrendlcHN3dGlsZXZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ2Mzg5ODMsImV4cCI6MjA3MDIxNDk4M30.r478QHojeaR7s6-wZUVjonPqOnaXo98IT1EZFJX2I3E"
};

// Инициализация
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const app = new Application();
const router = new Router();

// Middleware
app.use(oakCors({ origin: "*" }));
app.use(async (ctx, next) => {
  try {
    if (ctx.request.hasBody) {
      const body = ctx.request.body();
      ctx.state.body = body.type === "json" ? await body.value : {};
    }
    await next();
  } catch (err) {
    ctx.response.status = 500;
    ctx.response.body = { 
      success: false, 
      error: "Internal server error",
      details: err.message 
    };
  }
});

// Хелперы
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Роуты
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "AdRewards API is running",
    version: "1.0",
    endpoints: {
      register: "POST /register",
      reward: "GET/POST /reward?userid=ID&secret=KEY",
      user: "GET /user/:userId",
      withdraw: "POST /withdraw",
      tasks: "GET /tasks",
      completeTask: "POST /complete-task"
    }
  };
});

router.post("/register", async (ctx) => {
  const { refCode } = ctx.state.body || {};
  const userId = `user_${generateId()}`;
  const userRefCode = generateId().toString();

  const { error } = await supabase.from('users').insert({
    id: userId,
    ref_code: userRefCode,
    referred_by: refCode || null,
    balance: 0,
    daily_views: {},
    withdrawals: [],
    completed_tasks: []
  });

  if (error) {
    ctx.response.status = 400);
    ctx.response.body = { success: false, error: error.message };
    return;
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
    userId = ctx.state.body?.userId || ctx.state.body?.userid;
    secret = ctx.state.body?.secret;
  } else {
    userId = ctx.request.url.searchParams.get("userid");
    secret = ctx.request.url.searchParams.get("secret");
  }

  if (!userId) {
    ctx.response.status = 400);
    ctx.response.body = { success: false, error: "User ID is required" };
    return;
  }

  if (![CONFIG.SECRET_KEY, CONFIG.WEBHOOK_SECRET].includes(secret)) {
    ctx.response.status = 401);
    ctx.response.body = { success: false, error: "Invalid secret" };
    return;
  }

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  if (userError || !user) {
    ctx.response.status = 404);
    ctx.response.body = { success: false, error: "User not found" };
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const viewsToday = user.daily_views?.[today] || 0;

  if (viewsToday >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429);
    ctx.response.body = { success: false, error: "Daily limit reached" };
    return;
  }

  const newBalance = user.balance + CONFIG.REWARD_PER_AD;
  const newViews = { ...user.daily_views, [today]: viewsToday + 1 };

  const { error: updateError } = await supabase
    .from('users')
    .update({ balance: newBalance, daily_views: newViews })
    .eq('id', userId);

  if (updateError) {
    ctx.response.status = 500);
    ctx.response.body = { success: false, error: "Database update failed" };
    return;
  }

  ctx.response.body = {
    success: true,
    reward: CONFIG.REWARD_PER_AD,
    balance: newBalance,
    viewsToday: viewsToday + 1
  };
});

// Запуск сервера
app.use(router.routes());
app.use(router.allowedMethods());

app.use((ctx) => {
  ctx.response.status = 404);
  ctx.response.body = { success: false, error: "Endpoint not found" };
});

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
