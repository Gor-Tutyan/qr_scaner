const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const QRCode = require("qrcode");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ================ ПОДКЛЮЧЕНИЕ К БАЗЕ (работает на Render!) ================
const isProduction = process.env.RENDER || process.env.NODE_ENV === "production";

let dbPath;
let dbDir;

if (isProduction) {
  // На Render.com — только /tmp доступна для записи
  dbDir = "/tmp";
  dbPath = path.join(dbDir, "database.sqlite");
} else {
  // Локально — используем папку db в проекте
  dbDir = path.join(__dirname, "db");
  dbPath = path.join(dbDir, "database.sqlite");
  // Создаём папку, если её нет
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Ошибка подключения к SQLite:", err.message);
  } else {
    console.log(`SQLite подключена: ${dbPath}`);
  }
});

const sessions = new Map();

// Создаём таблицу
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
  sessions.set(sessionId, { scanned: false, customerCode: null, timestamp: Date.now() });

  const qrData = JSON.stringify({ sessionId });

  QRCode.toDataURL(qrData, { width: 500, margin: 2 }, (err, qrUrl) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Ошибка генерации QR");
    }

    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Касса — QR сканер</title>
  <style>
    body {font-family: Arial, sans-serif; text-align: center; padding: 40px; background: #f5f5f5; margin:0; min-height:100vh;}
    .qr {background: white; padding: 30px; border-radius: 20px; display: inline-block; box-shadow: 0 10px 30px rgba(0,0,0,0.15);}
    #status {margin: 30px auto; max-width: 600px;}
    .success-card {background: white; padding: 35px; border-radius: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.15);}
    .card-number {font-family: 'Courier New', monospace; font-size: 32px; letter-spacing: 5px; color: #0066cc; font-weight: bold;}
    .no-card {color: #999; font-style: italic; font-size: 24px;}
    button {padding: 14px 36px; font-size: 18px; background: #007bff; color: white; border: none; border-radius: 12px; cursor: pointer; margin: 10px;}
    code {background:#eee; padding:4px 8px; border-radius:6px; font-family:monospace;}
  </style>
</head>
<body>
  <h1>Покажите клиенту этот QR-код</h1>
  <div class="qr">
    <img src="${qrUrl}" alt="QR код">
  </div>
  <p><strong>Session ID:</strong> <code>${sessionId}</code></p>

  <div id="status"><div style="padding:20px; background:#fff3cd; border-radius:12px;">Ожидаем сканирование и ввод кода...</div></div>
  <button onclick="location.reload()">Новый QR-код</button>

  <script>
    const sid = "${sessionId}";

    function formatCard(num) {
      if (!num) return '<span class="no-card">не привязана</span>';
      return num.toString().replace(/(.{4})/g, '$1 ').trim();
    }

    function check() {
      fetch("/api/status/" + sid)
        .then(r => r.json())
        .then(d => {
          if (d.success) {
            document.getElementById("status").innerHTML = 
              '<div class="success-card">' +
                '<h2 style="color:#0b0; margin:0 0 20px">Клиент найден!</h2>' +
                '<p style="font-size:18px"><strong>Код:</strong> ' + (d.customerCode || "—") + '</p>' +
                '<p style="font-size:26px; margin:20px 0"><strong>' + 
                  (d.first_name || "") + " " + (d.last_name || "") + 
                '</strong></p>' +
                '<div style="margin:25px 0"><strong style="font-size:20px">Номер карты:</strong><br>' +
                  '<div class="card-number">' + formatCard(d.card_number) + '</div>' +
                '</div>' +
              '</div>';
          } else if (d.pending) {
            document.getElementById("status").innerHTML = 
              '<div style="padding:20px; background:#fffbe6; border-radius:12px;">Ожидаем код клиента...</div>';
          } else {
            document.getElementById("status").innerHTML = 
              '<div style="color:red; background:#ffebee; padding:20px; border-radius:12px">Ошибка: ' + 
              (d.error || "неизвестно") + '</div>';
          }
        })
        .catch(err => {
          document.getElementById("status").innerHTML = "Нет связи с сервером";
        });
    }

    setInterval(check, 2500);
    check();
  </script>
</body>
</html>`);
  });
});

// ================ ОСТАЛЬНЫЕ МАРШРУТЫ ================
app.get("/mobile", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "mobile.html"));
});

app.get("/mobile-scan", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "mobile-scan.html"));
});

app.get("/api/status/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({ error: "Сессия устарела" });

  if (s.scanned && s.customerCode) {
    db.get("SELECT * FROM clients WHERE client_code = ?", [s.customerCode], (err, row) => {
      if (err || !row) {
        res.json({ error: "Клиент не найден" });
      } else {
        res.json({
          success: true,
          customerCode: s.customerCode,
          first_name: row.first_name || "",
          last_name: row.last_name || "",
          card_number: row.card_number || null
        });
      }
    });
  } else {
    res.json({ pending: true });
  }
});

app.post("/api/scan", (req, res) => {
  const { sessionId, customerCode } = req.body;
  const s = sessions.get(sessionId);
  if (!s) return res.json({ error: "Сессия не найдена" });

  const code = customerCode.toString().trim().toUpperCase();

  db.get("SELECT * FROM clients WHERE client_code = ?", [code], (err, row) => {
    if (err || !row) {
      res.json({ error: "Клиент не найден" });
    } else {
      s.customerCode = code;
      s.scanned = true;
      res.json({ success: true, data: row });
    }
  });
});

// Очистка старых сессий каждые 5 минут
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessions.entries()) {
    if (now - value.timestamp > 10 * 60 * 1000) { // 10 минут
      sessions.delete(key);
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Сервер запущен!");
  console.log(`Касса: http://localhost:${PORT}`);
  console.log(`Мобильная: http://localhost:${PORT}/mobile`);
});