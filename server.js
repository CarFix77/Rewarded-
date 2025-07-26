const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Конфигурация
const CONFIG = {
  REWARD_PER_AD: 0.0003,
  SECRET_KEY: "wagner46375",
  DAILY_LIMIT: 30,
  MIN_WITHDRAW: 1.00,
  REFERRAL_PERCENT: 0.15,
  ADMIN_PASSWORD: "8223Nn8223",
  DB_FILE: path.join(__dirname, 'db.json')
};

// Инициализация "базы данных"
let db = {
  users: {},
  views: {},
  withdrawals: {},
  tasks: []
};

// Загрузка БД из файла
function loadDB() {
  try {
    if (fs.existsSync(CONFIG.DB_FILE)) {
      db = JSON.parse(fs.readFileSync(CONFIG.DB_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Ошибка загрузки БД:', e);
  }
}

// Сохранение БД в файл
function saveDB() {
  fs.writeFileSync(CONFIG.DB_FILE, JSON.stringify(db, null, 2));
}

// Генерация ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// Сервер
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Обслуживание статики
  if (pathname === '/' || pathname.startsWith('/static')) {
    return serveStatic(req, res);
  }

  // API endpoints
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        handleAPI(req, res, pathname, data, parsedUrl.query);
      } catch (e) {
        sendResponse(res, 400, { error: 'Invalid JSON' });
      }
    });
  } else {
    handleAPI(req, res, pathname, {}, parsedUrl.query);
  }
});

// Обработка API
function handleAPI(req, res, pathname, data, query) {
  try {
    switch (pathname) {
      case '/register':
        handleRegister(res, data);
        break;
      case '/reward':
        handleReward(res, query);
        break;
      case '/withdraw':
        handleWithdraw(res, data);
        break;
      case '/admin/login':
        handleAdminLogin(res, data);
        break;
      default:
        sendResponse(res, 404, { error: 'Not found' });
    }
  } catch (e) {
    sendResponse(res, 500, { error: 'Server error' });
  }
}

// Регистрация пользователя
function handleRegister(res, { refCode }) {
  const userId = 'user_' + generateId();
  const userRefCode = generateId();

  db.users[userId] = {
    balance: 0,
    refCode: userRefCode,
    refCount: 0,
    refEarnings: 0,
    createdAt: new Date().toISOString()
  };

  // Реферальная система
  if (refCode) {
    const referrer = Object.values(db.users).find(u => u.refCode === refCode);
    if (referrer) {
      const bonus = CONFIG.REWARD_PER_AD * CONFIG.REFERRAL_PERCENT;
      referrer.refCount++;
      referrer.refEarnings += bonus;
      referrer.balance += bonus;
    }
  }

  saveDB();
  sendResponse(res, 200, { userId, refCode: userRefCode });
}

// Награда за просмотр
function handleReward(res, { userid, secret }) {
  if (secret !== CONFIG.SECRET_KEY) {
    return sendResponse(res, 401, { error: 'Invalid secret' });
  }

  const today = new Date().toISOString().split('T')[0];
  const user = db.users[userid] || { balance: 0 };
  const viewsToday = db.views[`${userid}_${today}`] || 0;

  if (viewsToday >= CONFIG.DAILY_LIMIT) {
    return sendResponse(res, 429, { error: 'Daily limit reached' });
  }

  user.balance += CONFIG.REWARD_PER_AD;
  db.views[`${userid}_${today}`] = viewsToday + 1;
  db.users[userid] = user;

  saveDB();
  sendResponse(res, 200, {
    reward: CONFIG.REWARD_PER_AD,
    balance: user.balance,
    viewsToday: viewsToday + 1
  });
}

// Вывод средств
function handleWithdraw(res, { userId, wallet, amount }) {
  const user = db.users[userId];
  
  if (!user || amount < CONFIG.MIN_WITHDRAW || user.balance < amount) {
    return sendResponse(res, 400, { error: 'Invalid withdrawal' });
  }

  const withdrawId = 'wd_' + generateId();
  user.balance -= amount;
  db.withdrawals[withdrawId] = {
    userId,
    amount,
    wallet,
    date: new Date().toISOString(),
    status: 'pending'
  };

  saveDB();
  sendResponse(res, 200, { withdrawId });
}

// Админ-авторизация
function handleAdminLogin(res, { password }) {
  if (password === CONFIG.ADMIN_PASSWORD) {
    sendResponse(res, 200, { token: 'admin_' + generateId() });
  } else {
    sendResponse(res, 401, { error: 'Wrong password' });
  }
}

// Отправка статических файлов
function serveStatic(req, res) {
  let filePath = path.join(__dirname, 'public', 
    req.url === '/' ? 'index.html' : req.url);

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, content) => {
          if (err) {
            sendResponse(res, 404, 'Not found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content, 'utf-8');
          }
        });
      } else {
        sendResponse(res, 500, 'Server error');
      }
    } else {
      const extname = path.extname(filePath);
      let contentType = 'text/html';

      if (extname === '.js') contentType = 'text/javascript';
      else if (extname === '.css') contentType = 'text/css';

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
}

// Универсальный ответ
function sendResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Запуск сервера
loadDB();
server.listen(8000, () => {
  console.log(`Server running on http://localhost:8000`);
});
