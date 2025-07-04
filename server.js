// server.js - Полный сервер для AdRewards с базой данных
const CONFIG = {
  REWARD_PER_AD: 0.0003,  // $ за просмотр рекламы
  MIN_WITHDRAW: 1.00,     // Минимальная сумма вывода
  ADMIN_TOKEN: "8223Nn8223" // Пароль для админки
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const params = url.searchParams;

  // CORS для фронтенда
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  // Редирект на рекламу (+ начисление)
  if (path === "/go" && req.method === "GET") {
    const adUrl = params.get("url");
    const userId = params.get("user");
    
    if (!adUrl || !userId) {
      return errorResponse("Нужны параметры ?url= и &user=");
    }

    // Записываем просмотр
    await Deno.kv.set(
      ["ad_views", userId, Date.now()], 
      { url: adUrl, rewarded: CONFIG.REWARD_PER_AD }
    );

    // Начисляем баллы
    const balanceKey = ["balance", userId];
    const currentBalance = (await Deno.kv.get(balanceKey)).value || 0;
    await Deno.kv.set(balanceKey, currentBalance + CONFIG.REWARD_PER_AD);

    return Response.redirect(adUrl, 302);
  }

  // Проверка баланса
  if (path === "/balance" && req.method === "GET") {
    const userId = params.get("user");
    if (!userId) return errorResponse("Нужен параметр ?user=");
    
    const balance = (await Deno.kv.get(["balance", userId])).value || 0;
    return jsonResponse({ balance });
  }

  // Админка: список всех пользователей (требует токен)
  if (path === "/admin/users" && req.method === "GET") {
    if (req.headers.get("Authorization") !== `Bearer ${CONFIG.ADMIN_TOKEN}`) {
      return errorResponse("Доступ запрещён", 403);
    }

    const users = [];
    for await (const entry of Deno.kv.list({ prefix: ["balance"] })) {
      users.push({
        userId: entry.key[1],
        balance: entry.value
      });
    }
    
    return jsonResponse(users);
  }

  // Статус сервера
  return jsonResponse({ 
    status: "AdRewards Server 🚀",
    endpoints: {
      reward: "GET /go?url=URL&user=USER_ID",
      balance: "GET /balance?user=USER_ID",
      admin: "GET /admin/users (Authorization: Bearer TOKEN)"
    }
  });
});

// Вспомогательные функции
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}
