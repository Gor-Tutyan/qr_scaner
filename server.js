const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const QRCode = require("qrcode");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const db = new sqlite3.Database("./db/database.sqlite");
const sessions = new Map();

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    client_code TEXT PRIMARY KEY,
    card_number TEXT,
    first_name TEXT,
    last_name TEXT
  )`);
});

// ГЛАВНАЯ СТРАНИЦА — КАССА
app.get("/", (req, res) => {
  const sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  sessions.set(sessionId, { scanned: false, customerCode: null, timestamp: Date.now() });

  const qrData = JSON.stringify({ sessionId });

  QRCode.toDataURL(qrData, { width: 500, margin: 2 }, (err, qrUrl) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Ошибка генерации QR");
    }

    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Касса — QR сканер</title>
  <style>
    body {font-family: Arial, sans-serif; text-align: center; padding: 40px; background: #f5f5f5; margin:0;}
    .qr {background: white; padding: 30px; border-radius: 20px; display: inline-block; box-shadow: 0 10px 30px rgba(0,0,0,0.15);}
    #status {margin: 30px auto; padding: 20px; background: #fff3cd; border-radius: 12px; font-size: 20px; max-width: 600px;}
    .success-card {background: white; padding: 30px; border-radius: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.15); max-width: 550px; margin: 30px auto;}
    .card-number {font-family: 'Courier New', monospace; font-size: 32px; letter-spacing: 4px; color: #0066cc; font-weight: bold;}
    button {padding: 14px 36px; font-size: 18px; background: #007bff; color: white; border: none; border-radius: 12px; cursor: pointer; margin: 10px;}
    .no-card {color: #999; font-style: italic;}
  </style>
</head>
<body>
  <h1>Покажите клиенту этот QR-код</h1>
  <div class="qr">
    <img src="${qrUrl}" alt="QR код">
  </div>
  <p><strong>Session ID:</strong> <code>${sessionId}</code></p>

  <div id="status">Ожидаем сканирование и ввод кода...</div>
  <button onclick="location.reload()">Новый QR-код</button>

  <script>
    const sid = "${sessionId}";

    function formatCard(number) {
      if (!number) return '<span class="no-card">не привязана</span>';
      return number.toString().replace(/(.{4})/g, '$1 ').trim();
    }

    function check() {
      fetch("/api/status/" + sid)
        .then(r => r.json())
        .then(d => {
          if (d.success) {
            document.getElementById("status").innerHTML = 
              '<div class="success-card">' +
                '<h2 style="color:#0b0; margin-top:0">Клиент найден!</h2>' +
                '<p><strong>Код клиента:</strong> ' + (d.customerCode || "—") + '</p>' +
                '<p style="font-size:24px; margin:15px 0"><strong>' + 
                  (d.first_name || "") + " " + (d.last_name || "") + 
                '</strong></p>' +
                '<p style="margin:20px 0"><strong>Номер карты:</strong><br>' +
                  '<div class="card-number">' + formatCard(d.card_number) + '</div>' +
                '</p>' +
              '</div>';
          } else if (d.pending) {
            document.getElementById("status").innerHTML = "Ожидаем код клиента...";
            setTimeout(check, 2000);
          } else {
            document.getElementById("status").innerHTML = 
              '<span style="color:red">Ошибка: ' + (d.error || "неизвестно") + '</span>';
          }
        })
        .catch(() => {
          document.getElementById("status").innerHTML = "Нет связи с сервером";
        });
    }

    setInterval(check, 3000);
    check();
  </script>
</body>
</html>
    `);
  });
});

// Остальные маршруты без изменений
app.get("/mobile", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "mobile.html"));
});

app.get("/mobile-scan", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "mobile-scan.html"));
});

app.get("/api/status/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({error: "Сессия устарела или недействительна"});

  if (s.scanned && s.customerCode) {
    db.get("SELECT * FROM clients WHERE client_code=?", [s.customerCode], (err, row) => {
      if (err || !row) {
        res.json({error: "Клиент не найден в базе"});
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
    res.json({pending: true});
  }
});

app.post("/api/scan", (req, res) => {
  const {sessionId, customerCode} = req.body;
  const s = sessions.get(sessionId);
  if (!s) return res.json({error: "Сессия не найдена"});

  const code = customerCode.toString().trim().toUpperCase();

  db.get("SELECT * FROM clients WHERE client_code=?", [code], (err, row) => {
    if (err) {
      console.error(err);
      return res.json({error: "Ошибка базы данных"});
    }
    if (row) {
      s.customerCode = code;
      s.scanned = true;
      res.json({success: true, data: row});
    } else {
      res.json({error: "Клиент с таким кодом не найден"});
    }
  });
});

// Дополнительный маршрут (если используешь отдельно)
app.get("/api/generate-qr/:id", (req, res) => {
  const sessionId = req.params.id;
  sessions.set(sessionId, { scanned: false, customerCode: null, timestamp: Date.now() });

  const qrData = JSON.stringify({ sessionId });
  QRCode.toDataURL(qrData, { width: 500, margin: 2 }, (err, qrUrl) => {
    if (err) return res.json({error: "QR error"});
    res.json({ qr: qrUrl });
  });
});

// Очистка старых сессий (опционально, каждые 10 минут)
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessions) {
    if (now - value.timestamp > 10 * 60 * 1000) { // 10 минут
      sessions.delete(key);
    }
  }
}, 60000);

app.listen(3000, "0.0.0.0", () => {
  console.log("Сервер запущен!");
  console.log("Касс: http://localhost:3000");
  console.log("Мобильная версия: http://<твой-ip>:3000/mobile");
});