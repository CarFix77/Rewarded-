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
    ctx.response.body = { success: false, error: err.message };
  }
});

// Хелперы
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Роуты
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

  ctx.response.body = error
    ? { success: false, error: "Registration failed" }
    : { success: true, userId, refCode: userRefCode };
});

router.all("/reward", async (ctx) => {
  const userId = ctx.state.body?.userId || ctx.request.url.searchParams.get("userid");
  const secret = ctx.state.body?.secret || ctx.request.url.searchParams.get("secret");

  if (![CONFIG.SECRET_KEY, CONFIG.WEBHOOK_SECRET].includes(secret)) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Invalid secret" };
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  const viewsToday = user?.daily_views?.[today] || 0;
  if (viewsToday >= CONFIG.DAILY_LIMIT) {
    ctx.response.status = 429;
    ctx.response.body = { success: false, error: "Daily limit reached" };
    return;
  }

  await supabase
    .from('users')
    .update({
      balance: user.balance + CONFIG.REWARD_PER_AD,
      daily_views: { ...user.daily_views, [today]: viewsToday + 1 }
    })
    .eq('id', userId);

  ctx.response.body = {
    success: true,
    balance: user.balance + CONFIG.REWARD_PER_AD,
    viewsToday: viewsToday + 1
  };
});

router.post("/withdraw", async (ctx) => {
  const { userId, wallet, amount } = ctx.state.body || {};
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  if (amount < CONFIG.MIN_WITHDRAW || user.balance < amount) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "Invalid amount" };
    return;
  }

  const withdrawal = {
    id: `wd_${generateId()}`,
    amount,
    wallet,
    status: "pending",
    created_at: new Date().toISOString()
  };

  await supabase
    .from('users')
    .update({
      balance: user.balance - amount,
      withdrawals: [...user.withdrawals, withdrawal]
    })
    .eq('id', userId);

  ctx.response.body = { success: true, withdrawalId: withdrawal.id };
});

// Запуск сервера
app.use(router.routes());
app.use(router.allowedMethods());

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
