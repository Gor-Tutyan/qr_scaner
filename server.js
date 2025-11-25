const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const QRCode = require("qrcode");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const isProduction = process.env.RENDER || process.env.NODE_ENV === "production";
const dbPath = isProduction ? "/tmp/database.sqlite" : path.join(__dirname, "db", "database.sqlite");
if (!isProduction) fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new sqlite3.Database(dbPath);
const sessions = new Map();

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    client_code TEXT PRIMARY KEY,
    card_number TEXT,
    first_name TEXT,
    last_name TEXT
  )`);
});

app.get("/", (req, res) => {
  const sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  sessions.set(sessionId, { scanned: false, customerCode: null, timestamp: Date.now(), cardDesign: null });

  QRCode.toDataURL(JSON.stringify({ sessionId }), { width: 500, margin: 2 }, (err, qrUrl) => {
    if (err) return res.status(500).send("QR Error");

    const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unibank — выдача карты</title>
  <style>
    body{font-family:Arial,sans-serif;background:#f8f9fa;margin:0;padding:20px;text-align:center}
    h1{margin:30px 0 50px;font-size:32px;color:#003087}
    .designs{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:30px;max-width:1200px;margin:0 auto}
    .card-btn{border-radius:20px;overflow:hidden;box-shadow:0 12px 35px rgba(0,0,0,0.25);cursor:pointer;transition:0.3s;background:white}
    .card-btn:hover{transform:translateY(-12px);box-shadow:0 25px 50px rgba(0,0,0,0.3)}
    .card-btn img{width:100%;display:block}
    .card-name{background:#003087;color:#fff;padding:16px;font-size:22px;font-weight:bold}
    #qr-area{display:none;margin:50px auto;padding:40px;background:white;border-radius:25px;box-shadow:0 15px 50px rgba(0,0,0,0.2);max-width:650px}
    #qr-img{background:white;padding:25px;border-radius:18px;display:inline-block;box-shadow:0 8px 25px rgba(0,0,0,0.15)}
    #status{margin:30px auto;padding:30px;background:#e3f2fd;border-radius:15px;max-width:650px;font-size:20px;color:#003087}
    button{background:#003087;color:white;padding:16px 40px;font-size:20px;border:none;border-radius:15px;cursor:pointer;margin:15px}
    #final-card{display:block;margin:40px auto;max-width:650px;border-radius:25px;overflow:hidden;box-shadow:0 25px 60px rgba(0,0,0,0.4)}
  </style>
</head>
<body>

  <h1>Выберите дизайн карты клиента</h1>
  <div class="designs">
    <div class="card-btn" onclick="choose(1)"><img src="/cards/card1.png" alt="1"><div class="card-name">Дизайн 1</div></div>
    <div class="card-btn" onclick="choose(2)"><img src="/cards/card2.png" alt="2"><div class="card-name">Дизайн 2</div></div>
    <div class="card-btn" onclick="choose(3)"><img src="/cards/card3.png" alt="3"><div class="card-name">Дизайн 3</div></div>
    <div class="card-btn" onclick="choose(4)"><img src="/cards/card4.png" alt="4"><div class="card-name">Дизайн 4</div></div>
  </div>

  <div id="qr-area">
    <h2>Покажите клиенту QR-код</h2>
    <div id="qr-img"><img src="${qrUrl}" style="width:100%;max-width:420px"></div>
    <p style="margin:30px 0;font-size:22px"><strong>Выбран дизайн:</strong> <span id="sel">-</span></p>
    <div id="status">Ожидаем подтверждение клиента...</div>
    <button onclick="location.reload()">Новый клиент</button>
  </div>

  <script>
    const sid = "${sessionId}";

    function choose(design) {
      fetch("/api/set-design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, design })
      });

      document.querySelector(".designs").style.display = "none";
      document.getElementById("qr-area").style.display = "block";
      document.getElementById("sel").textContent = design;
      startPolling();
    }

    function startPolling() {
      const interval = setInterval(() => {
        fetch("/api/status/" + sid)
          .then(r => r.json())
          .then(data => {
            if (data.success) {
              clearInterval(interval);
              const number = (data.card_number || "4111111111111111").replace(/(.{4})/g, "$1 ").trim();
              const name = (data.first_name + " " + data.last_name).toUpperCase();

              document.getElementById("status").innerHTML = 
                '<div id="final-card">' +
                  '<canvas id="cardCanvas" width="950" height="600"></canvas>' +
                '</div>';

              const canvas = document.getElementById("cardCanvas");
              const ctx = canvas.getContext("2d");
              const img = new Image();
              img.onload = function() {
                ctx.drawImage(img, 0, 0, 950, 600);

                ctx.fillStyle = "#ffffff";
                ctx.strokeStyle = "#000000";
                ctx.lineWidth = 6;

                // Имя держателя
                ctx.font = "bold 48px Arial";
                ctx.strokeText(name, 130, 480);
                ctx.fillText(name, 130, 480);

                // Номер карты
                ctx.font = "bold 56px 'Courier New', monospace";
                ctx.textAlign = "center";
                ctx.strokeText(number, 475, 560);
                ctx.fillText(number, 475, 560);
              };
              img.src = "/cards/card" + (data.design || 1) + ".png?t=" + Date.now();
            }
          })
          .catch(err => console.error("Polling error:", err));
      }, 1800);
    }
  </script>
</body>
</html>`;

    res.send(html);
  });
});

// === API ===
app.post("/api/set-design", (req, res) => {
  const { sessionId, design } = req.body;
  const s = sessions.get(sessionId);
  if (s) s.cardDesign = Number(design);
  res.json({ ok: true });
});

app.get("/api/status/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !s.scanned || !s.customerCode) return res.json({ pending: true });

  db.get("SELECT * FROM clients WHERE client_code=?", [s.customerCode], (err, row) => {
    if (err || !row) return res.json({ error: "Не найден" });
    res.json({
      success: true,
      first_name: row.first_name || "ИВАН",
      last_name: row.last_name || "ИВАНОВ",
      card_number: row.card_number || "4111111111111111",
      design: s.cardDesign || 1
    });
  });
});

app.post("/api/scan", (req, res) => {
  const { sessionId, customerCode } = req.body;
  const s = sessions.get(sessionId);
  if (!s) return res.json({ error: "Сессия не найдена" });

  const code = (customerCode + "").trim().replace(/\D/g, "");
  if (!code) return res.json({ error: "Код пустой" });

  db.get("SELECT * FROM clients WHERE client_code=?", [code], (err, row) => {
    if (row) {
      s.customerCode = code;
      s.scanned = true;
      res.json({ success: true, data: row });
    } else {
      res.json({ error: "Клиент не найден" });
    }
  });
});

app.get("/mobile", (req, res) => res.sendFile(path.join(__dirname, "public", "mobile.html")));
app.get("/mobile-scan", (req, res) => res.sendFile(path.join(__dirname, "public", "mobile-scan.html")));

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.timestamp > 600000) sessions.delete(k);
  }
}, 300000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Сервер запущен: http://localhost:${PORT}`));