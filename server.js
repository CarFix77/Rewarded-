import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";

const app = new Application();
const router = new Router();

// Обязательный корневой роут
router.get("/", (ctx) => {
  ctx.response.body = {
    status: "online",
    message: "AdRewards PRO Server",
    endpoints: [
      "POST /register - Регистрация",
      "GET /reward?userid=ID&secret=KEY - Получить награду",
      "POST /withdraw - Вывод средств"
    ]
  };
});

// Простейшая регистрация для теста
router.post("/register", async (ctx) => {
  try {
    const body = await ctx.request.body().value;
    ctx.response.body = {
      userId: "test_user_123",
      refCode: "ref456",
      balance: 0
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { error: "Registration error" };
  }
});

// Настройка CORS
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  await next();
});

app.use(router.routes());
app.use(router.allowedMethods());

const port = 8000;
console.log(`Server started on port ${port}`);
await app.listen({ port });
