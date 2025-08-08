import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

function generateId() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Routes
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "API is working",
    endpoints: [
      "POST /register",
      "GET|POST /reward?userid=ID&secret=KEY",
      "GET /user/:userId",
      "POST /withdraw"
    ]
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
    ctx.response.status = 400;  // Исправлено: удалена лишняя скобка
    ctx.response.body = { success: false, error: error.message };
    return;
  }

  ctx.response.body = {
    success: true,
    userId,
    refCode: userRefCode
  };
});

// Остальные роуты...

app.use(router.routes());
app.use(router.allowedMethods());

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
await app.listen({ port });
