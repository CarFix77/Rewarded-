import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { oakCors } from "https://deno.land/x/cors/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Bot } from "https://deno.land/x/grammy/mod.ts";

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

// Инициализация Supabase
const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "https://ibnxrjoxhjpmkjwzpngw.supabase.co",
  Deno.env.get("SUPABASE_KEY") || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
);

const app = new Application();
const router = new Router();
const bot = new Bot(Deno.env.get("BOT_TOKEN") || "8178465909:AAFaHnIfv1Wyt3PIkT0B64vKEEoJOS9mkt4");

// Middleware CORS для фронтенда
app.use(oakCors({
  origin: CONFIG.FRONTEND_URL,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

// Обработка тела запроса
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

// Генерация ID
function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Telegram Bot
bot.command("start", async (ctx) => {
  const userId = `tg_${ctx.from.id}`;
  const userRefCode = generateId().toString();

  const { data: existingUser } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!existingUser) {
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

  await ctx.reply(`👋 Добро пожаловать!`, {
    reply_markup: {
      inline_keyboard: [[{
        text: "Открыть приложение",
        web_app: { url: `${CONFIG.FRONTEND_URL}?userId=${userId}` }
      }]]
    }
  });
});

// API Endpoints
router.post("/api/register", async (ctx) => {
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
    refLink: `${CONFIG.FRONTEND_URL}?ref=${userRefCode}`
  };
});

router.post("/api/reward", async (ctx) => {
  const { userId, secret } = ctx.state.body || {};

  if (!userId) {
    ctx.response.status = 400;
    ctx.response.body = { success: false, error: "User ID is required" };
    return;
  }

  if (secret !== CONFIG.SECRET_KEY) {
    ctx.response.status = 401;
    ctx.response.body = { success: false, error: "Invalid secret" };
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  
  const [{ data: user, error: userError }, { data: viewsData }] = await Promise.all([
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
  
  await supabase.from("views").upsert({
    user_id: userId,
    date: today,
    count: dailyViews + 1
  }, { onConflict: "user_id,date" });

  await supabase
    .from("users")
    .update({ 
      balance: newBalance,
      total_views: newTotalViews 
    })
    .eq("user_id", userId);

  ctx.response.body = {
    success: true,
    reward: totalReward,
    balance: newBalance,
    viewsToday: dailyViews + 1,
    totalViews: newTotalViews
  };
});

// Добавьте остальные endpoint'ы аналогично

// Запуск сервера
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);

app.use(router.routes());
app.use(router.allowedMethods());

await Promise.all([
  app.listen({ port }),
  bot.start()
]);
