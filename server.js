const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const QRCode = require("qrcode");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ================ БАЗА ДАННЫХ ================
const isProduction = process.env.RENDER || process.env.NODE_ENV === "production";
const dbPath = isProduction 
  ? "/tmp/database.sqlite" 
  : path.join(__dirname, "db", "database.sqlite");

if (!isProduction) fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new sqlite3.Database(dbPath, (err) => {
  err ? console.error("Ошибка БД:", err) : console.log("БД подключена:", dbPath);
});

const sessions = new Map();

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    client_code TEXT PRIMARY KEY,
    card_number TEXT,
    first_name TEXT,
    last_name TEXT
  )`);
});

// ================ ГЛАВНАЯ СТРАНИЦА — КАССА ================
app.get("/", (req, res) => {
  const sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  sessions.set(sessionId, { 
    scanned: false, 
    customerCode: null, 
    timestamp: Date.now(), 
    cardDesign: null 
  });

  // Генерируем QR-код на сервере
  QRCode.toDataURL(JSON.stringify({ sessionId }), { width: 500, margin: 2 }, (err, qrUrl) => {
    if (err) {
      console.error("Ошибка генерации QR:", err);
      return res.status(500).send("Ошибка генерации QR");
    }

    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Касса — выбор карты</title>
  <style>
    body{font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px;text-align:center}
    h1{margin:30px 0 40px;font-size:28px;color:#333}
    .designs{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:25px;max-width:1100px;margin:0 auto}
    .card-btn{border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,0.2);cursor:pointer;transition:0.3s;background:white}
    .card-btn:hover{transform:translateY(-10px);box-shadow:0 20px 40px rgba(0,0,0,0.3)}
    .card-btn img{width:100%;display:block}
    .card-name{background:#222;color:#fff;padding:14px;font-size:19px;font-weight:bold}
    #qr-area{display:none;margin:40px auto;padding:30px;background:white;border-radius:20px;box-shadow:0 10px 40px rgba(0,0,0,0.15);max-width:600px}
    #qr-img{background:white;padding:20px;border-radius:15px;display:inline-block}
    #status{margin:30px auto;padding:25px;background:#fffbe6;border-radius:12px;max-width:600px;font-size:18px}
    .result-card{border-radius:20px;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,0.3);max-width:500px;margin:40px auto}
    .result-card img{width:100%}
    .info{padding:25px;background:rgba(0,0,0,0.85);color:white}
    .name{font-size:30px;font-weight:bold;margin:10px 0}
    .number{font-family:monospace;font-size:32px;letter-spacing:6px;color:#0f0}
    button{background:#007bff;color:white;padding:14px 32px;font-size:18px;border:none;border-radius:12px;cursor:pointer;margin:10px}
  </style>
</head>
<body>

  <h1>Выберите дизайн карты клиента</h1>
  <div class="designs">
    ${[1,2,3,4].map(i => `
      <div class="card-btn" onclick="choose(${i})">
        <img src="/cards/card${i}.png" alt="Дизайн ${i}">
        <div class="card-name">Дизайн ${i}</div>
      </div>
    `).join('')}
  </div>

  <div id="qr-area">
    <h2>Покажите клиенту этот QR-код</h2>
    <div id="qr-img"><img src="${qrUrl}" style="width:100%;max-width:400px"></div>
    <p style="margin:20px 0;font-size:20px"><strong>Выбран дизайн:</strong> <span id="sel">—</span></p>
    <div id="status">Ожидаем сканирование и ввод кода клиента...</div>
    <button onclick="location.reload()">Новый клиент</button>
  </div>

  <script>
    const sid = "${sessionId}";

    function choose(design) {
      // Сохраняем выбранный дизайн
      fetch("/api/set-design", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({sessionId: sid, design})
      });

      // Показываем QR и статус
      document.querySelector(".designs").style.display = "none";
      document.getElementById("qr-area").style.display = "block";
      document.getElementById("sel").textContent = design;

      // Запускаем опрос статуса
      startPolling();
    }

    function startPolling() {
      const interval = setInterval(() => {
        fetch("/api/status/" + sid)
          .then(r => r.json())
          .then(data => {
            if (data.success) {
              clearInterval(interval);
              document.getElementById("status").innerHTML = 
                '<div class="result-card">' +
                  '<img src="/cards/card' + (data.design || 1) + '.png" alt="Карта клиента">' +
                  '<div class="info">' +
                    '<div class="name">' + data.first_name + ' ' + data.last_name + '</div>' +
                    '<div class="number">' + 
                      (data.card_number ? data.card_number.replace(/(.{4})/g,"$1 ").trim() : "—") +
                    '</div>' +
                  '</div>' +
                '</div>';
            }
          })
          .catch(err => console.log("Ошибка опроса:", err));
      }, 2000);
    }
  </script>
</body>
</html>
    `);
  });
});

// ================ API ================
app.post("/api/set-design", (req, res) => {
  const { sessionId, design } = req.body;
  const s = sessions.get(sessionId);
  if (s) s.cardDesign = Number(design);
  res.json({ok: true});
});

app.get("/api/status/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({error: "Сессия устарела"});

  if (s.scanned && s.customerCode) {
    db.get("SELECT * FROM clients WHERE client_code = ?", [s.customerCode], (err, row) => {
      if (err || !row) return res.json({error: "Клиент не найден"});
      res.json({
        success: true,
        first_name: row.first_name || "",
        last_name: row.last_name || "",
        card_number: row.card_number || null,
        design: s.cardDesign || 1
      });
    });
  } else {
    res.json({pending: true});
  }
});

app.post("/api/scan", (req, res) => {
  const { sessionId, customerCode } = req.body;
  const s = sessions.get(sessionId);
  if (!s) return res.json({error: "Сессия не найдена"});

  const code = customerCode?.toString().trim().replace(/\D/g, "");
  if (!code) return res.json({error: "Код пустой"});

  db.get("SELECT * FROM clients WHERE client_code = ?", [code], (err, row) => {
    if (err) return res.json({error: "Ошибка сервера"});
    if (row) {
      s.customerCode = code;
      s.scanned = true;
      res.json({success: true, data: row});
    } else {
      res.json({error: "Клиент не найден"});
    }
  });
});

// Мобильные страницы
app.get("/mobile", (req, res) => res.sendFile(path.join(__dirname, "public", "mobile.html")));
app.get("/mobile-scan", (req, res) => res.sendFile(path.join(__dirname, "public", "mobile-scan.html")));

// Очистка старых сессий
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.timestamp > 10 * 60 * 1000) sessions.delete(k);
  }
}, 300000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Сервер запущен!");
  console.log(`Касса → http://localhost:${PORT}`);
  console.log(`Телефон → http://localhost:${PORT}/mobile`);
});