// Простейший сервер с базой данных
Deno.serve(async (req) => {
  const url = new URL(req.url);
  
  // Редирект + запись в DB
  if (url.pathname === "/go") {
    const adUrl = url.searchParams.get("url");
    const userId = url.searchParams.get("user");
    
    // Автоматическое создание DB (не нужно настраивать)
    await Deno.kv.set(["views", userId, Date.now()], adUrl);
    
    return Response.redirect(adUrl, 302);
  }
  
  // Проверка данных (GET /stats?user=123)
  if (url.pathname === "/stats") {
    const userId = url.searchParams.get("user");
    const entries = [];
    
    for await (const entry of Deno.kv.list(["views", userId])) {
      entries.push(entry.value);
    }
    
    return new Response(JSON.stringify(entries));
  }
  
  return new Response("AdRewards Server OK 🚀");
});
