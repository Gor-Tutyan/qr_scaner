const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const QRCode = require("qrcode");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const { exec } = require("child_process");

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

// === ГЛАВНАЯ СТРАНИЦА КАССЫ ===
app.get("/", (req, res) => {
  const sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  sessions.set(sessionId, { scanned: false, customerCode: null, timestamp: Date.now(), cardDesign: null });

  const mobileUrl = `${req.protocol}://${req.get("host")}/mobile-scan.html?sid=${sessionId}`;

  QRCode.toDataURL(mobileUrl, { width: 500, margin: 2 }, (err, qrUrl) => {
    if (err) return res.status(500).send("QR Error");

    res.send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><title>Unibank — Выдача карты</title>
<style>
  body{font-family:Arial,sans-serif;background:#f8f9fa;margin:0;padding:20px;text-align:center}
  h1{margin:40px 0 50px;font-size:32px;color:#003087;font-weight:bold}
  .designs{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:30px;max-width:1200px;margin:0 auto}
  .card-btn{border-radius:20px;overflow:hidden;box-shadow:0 12px 35px rgba(0,0,0,0.25);cursor:pointer;transition:.3s;background:white}
  .card-btn:hover{transform:translateY(-12px);box-shadow:0 25px 50px rgba(0,0,0,0.3)}
  .card-btn img{width:100%;display:block}
  .card-name{background:#003087;color:#fff;padding:16px;font-size:22px;font-weight:bold}
  #qr-area{display:none;margin:50px auto;padding:40px;background:white;border-radius:25px;box-shadow:0 15px 50px rgba(0,0,0,0.2);max-width:650px}
  button{background:#003087;color:white;padding:16px 40px;font-size:20px;border:none;border-radius:15px;cursor:pointer;margin:15px}
</style></head><body>

<h1>Выберите дизайн карты клиента</h1>
<div class="designs">
  <div class="card-btn" onclick="choose(1)"><img src="/cards/card1.png"><div class="card-name">Дизайн 1</div></div>
  <div class="card-btn" onclick="choose(2)"><img src="/cards/card2.png"><div class="card-name">Дизайн 2</div></div>
  <div class="card-btn" onclick="choose(3)"><img src="/cards/card3.png"><div class="card-name">Дизайн 3</div></div>
  <div class="card-btn" onclick="choose(4)"><img src="/cards/card4.png"><div class="card-name">Дизайн 4</div></div>
</div>

<div id="qr-area">
  <h2>Покажите клиенту QR-код</h2>
  <img src="${qrUrl}" style="width:100%;max-width:420px;margin:20px">
  <p><strong>Выбран дизайн:</strong> <span id="sel">-</span></p>
  <div id="status">Ожидаем подтверждение клиента...</div>
  <button onclick="location.reload()">Новый клиент</button>
</div>

<script>
  const sid = "${sessionId}";
  function choose(d) {
    fetch("/api/set-design", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:sid,design:d})});
    document.querySelector(".designs").style.display="none";
    document.getElementById("qr-area").style.display="block";
    document.getElementById("sel").textContent = d;
    setInterval(()=>fetch("/api/status/"+sid).then(r=>r.json()).then(data=>{
      if(data.success){
        const name = (data.first_name + " " + data.last_name).toUpperCase();
        const number = (data.card_number||"4111111111111111").replace(/(.{4})/g,"$1 ").trim();
        const design = data.design || 1;
        location.href = "/card-result.html?name="+encodeURIComponent(name)+"&number="+encodeURIComponent(number)+"&design="+design;
      }
    }), 1500);
  }
</script>
</body></html>`);
  });
});

// Сохранение дизайна
app.post("/api/set-design", (req, res) => {
  const { sessionId, design } = req.body;
  if (sessions.has(sessionId)) sessions.get(sessionId).cardDesign = Number(design);
  res.json({ ok: true });
});

// Статус для кассы
app.get("/api/status/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !s.scanned || !s.customerCode) return res.json({ pending: true });

  db.get("SELECT * FROM clients WHERE client_code = ?", [s.customerCode], (err, row) => {
    if (!row) return res.json({ error: "Клиент не найден" });
    res.json({
      success: true,
      first_name: row.first_name || "ИВАН",
      last_name: row.last_name || "ИВАНОВ",
      card_number: row.card_number || "4111111111111111",
      design: s.cardDesign || 1
    });
  });
});

// === ГЛАВНЫЙ ЭНДПОИНТ СКАНИРОВАНИЯ + УМНАЯ ПЕЧАТЬ ===
app.post("/api/scan", (req, res) => {
  const { sessionId, customerCode } = req.body;
  if (!sessionId || !customerCode) return res.json({ error: "Нет данных" });

  const s = sessions.get(sessionId);
  if (!s) return res.json({ error: "Сессия истекла" });

  const code = customerCode.toString().trim().replace(/\D/g, "");
  if (code.length < 4) return res.json({ error: "Короткий код" });

  db.get("SELECT * FROM clients WHERE client_code = ?", [code], (err, row) => {
    if (err || !row) {
      console.log("Клиент НЕ найден по коду:", code);
      return res.json({ error: "Клиент не найден" });
    }

    s.scanned = true;
    s.customerCode = code;

    const cleanCardNumber = (row.card_number || "").replace(/\s/g, "").trim();
    console.log(`Клиент: ${row.first_name} ${row.last_name} | Карта: ${cleanCardNumber}`);

    // === ПОИСК СТРОКИ В .CPS2 ФАЙЛАХ ===
    const printsDir = path.join(__dirname, "public", "prints");

    fs.access(printsDir, err => {
      if (err) {
        console.log("Папка public/prints НЕ найдена или недоступна");
        return res.json({ success: true, printed: false, note: "Папка prints отсутствует" });
      }

      fs.readdir(printsDir, (err, files) => {
        if (err || !files || files.length === 0) {
          console.log("В папке prints нет файлов");
          return res.json({ success: true, printed: false, note: "Нет файлов" });
        }

        const cps2Files = files
          .filter(f => f.toLowerCase().endsWith(".cps2"))
          .map(f => path.join(printsDir, f));

        if (cps2Files.length === 0) {
          console.log("Нет .cps2 файлов в папке prints");
          return res.json({ success: true, printed: false, note: "Нет .cps2 файлов" });
        }

        console.log(`Проверяем ${cps2Files.length} файл(ов):`, cps2Files.map(f => path.basename(f)).join(", "));

        let foundLine = null;
        let checked = 0;

        const checkNext = () => {
          if (checked >= cps2Files.length) {
            if (foundLine) {
              printOnA4(foundLine);
              res.json({ success: true, printed: true });
            } else {
              console.log("СТРОКА С НОМЕРОМ КАРТЫ НЕ НАЙДЕНА НИ В ОДНОМ ФАЙЛЕ");
              res.json({ success: true, printed: false, note: "Строка не найдена" });
            }
            return;
          }

          const filePath = cps2Files[checked++];
          fs.readFile(filePath, "utf8", (err, content) => {
            if (err) {
              console.log(`Ошибка чтения ${path.basename(filePath)}:`, err.message);
              checkNext();
              return;
            }

            const line = content.split("\n").find(l => l.includes(cleanCardNumber) && l.trim() !== "");
            if (line) {
              foundLine = line.trim();
              console.log(`НАЙДЕНО в ${path.basename(filePath)} → ${foundLine}`);
              printOnA4(foundLine);
              res.json({ success: true, printed: true, file: path.basename(filePath) });
            } else {
              checkNext();
            }
          });
        };

        checkNext();
      });
    });
  });

  // === ПЕЧАТЬ НА ОБЫЧНЫЙ ПРИНТЕР A4 ===
  function printOnA4(text) {
    console.log("ПЕЧАТАЕМ:", text);

    const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  @page { margin: 1.5cm; size: A4 portrait; }
  body { font-family: Arial, sans-serif; text-align: center; padding-top: 6cm; }
  .data { font-size: 52px; font-weight: bold; color: #003087; margin: 40px 0; line-height: 1.4; }
  .success { font-size: 48px; color: #006400; margin-top: 80px; }
</style>
</head>
<body>
  <div class="data">${text.replace(/</g, "&lt;")}</div>
  <div class="success">КАРТА УСПЕШНО ВЫДАНА</div>
</body></html>`;

    const tempFile = path.join(os.tmpdir(), `unibank_${Date.now()}.html`);
    fs.writeFileSync(tempFile, html, "utf8");

    const cmd = process.platform === "win32"
      ? `powershell -Command "Start-Process '${tempFile}' -Verb Print"`
      : `lp "${tempFile}"`;

    exec(cmd, { timeout: 20000 }, (err, stdout, stderr) => {
      if (err || stderr) {
        console.log("ОШИБКА ПЕЧАТИ:", err?.message || stderr);
      } else {
        console.log("УСПЕШНО ОТПРАВЛЕНО НА ПРИНТЕР");
      }
      setTimeout(() => fs.unlink(tempFile, () => {}), 20000);
    });
  }
});

// Мобильная страница
app.get("/mobile-scan.html", (req, res) => {
  const sid = req.query.sid;
  if (sid && /^[a-z0-9]{32}$/.test(sid)) {
    res.sendFile(path.join(__dirname, "public", "mobile-scan.html"));
  } else {
    res.status(400).send("Неверный sid");
  }
});

app.get("/mobile", (req, res) => res.redirect("/"));

// Очистка старых сессий каждые 5 минут
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.timestamp > 600000) sessions.delete(k);
  }
}, 300000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Сервер Unibank запущен!");
  console.log(`http://localhost:${PORT}`);
});