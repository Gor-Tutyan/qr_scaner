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
const sessions = new Map(); // sessionId → { scanned, customerCode, timestamp, cardDesign }

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    client_code TEXT PRIMARY KEY,
    card_number TEXT,
    first_name TEXT,
    last_name TEXT
  )`);
});

// === ГЛАВНАЯ СТРАНИЦА С QR-КОДОМ ===
app.get("/", (req, res) => {
  const sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  sessions.set(sessionId, { scanned: false, customerCode: null, timestamp: Date.now(), cardDesign: null });

  const mobileUrl = `${req.protocol}://${req.get("host")}/mobile-scan.html?sid=${sessionId}`;

  QRCode.toDataURL(mobileUrl, { width: 500, margin: 2 }, (err, qrUrl) => {
    if (err) return res.status(500).send("QR Error");

    res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Unibank — Выдача карты</title>
<style>
  body{font-family:Arial;background:#f8f9fa;margin:0;padding:20px;text-align:center}
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
    }),1800);
  }
</script>
</body></html>`);
  });
});

// === ВЫБОР ДИЗАЙНА ===
app.post("/api/set-design", (req, res) => {
  const { sessionId, design } = req.body;
  if (sessions.has(sessionId)) {
    sessions.get(sessionId).cardDesign = Number(design);
  }
  res.json({ok:true});
});

// === СТАТУС ДЛЯ ОПРОСА ===
app.get("/api/status/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !s.scanned || !s.customerCode) return res.json({pending:true});

  db.get("SELECT * FROM clients WHERE client_code=?", [s.customerCode], (err, row) => {
    if (!row) return res.json({error:"Не найден"});
    res.json({
      success: true,
      first_name: row.first_name || "ИВАН",
      last_name: row.last_name || "ИВАНОВ",
      card_number: row.card_number || "4111111111111111",
      design: s.cardDesign || 1
    });
  });
});

// === СКАНИРОВАНИЕ / ВВОД КОДА КЛИЕНТА ===
app.post("/api/scan", (req, res) => {
  const { sessionId, customerCode } = req.body;
  const s = sessions.get(sessionId);
  if (!s) return res.json({ error: "Сессия не найдена" });

  const code = (customerCode + "").trim().replace(/\D/g, "");
  if (!code) return res.json({ error: "Код пустой" });

  db.get("SELECT * FROM clients WHERE client_code=?", [code], (err, row) => {
    if (!row) return res.json({ error: "Клиент не найден" });

    s.customerCode = code;
    s.scanned = true;

    // === ПЕЧАТЬ НА ОБЫЧНОМ A4 ПРИНТЕРЕ (ищем номер карты в .cps2 файлах) ===
    const cardNumber = (row.card_number || "").replace(/\s/g, "");
    const printsDir = path.join(__dirname, "public", "prints");

    fs.readdir(printsDir, (err, files) => {
      if (err || !files || !files.length) return res.json({ success: true });

      const cps2Files = files.filter(f => f.toLowerCase().endsWith(".cps2"));
      let foundLine = null;

      const checkNext = (i) => {
        if (i >= cps2Files.length || foundLine) {
          if (foundLine) printOnA4(foundLine);
          return res.json({ success: true });
        }

        const filePath = path.join(printsDir, cps2Files[i]);
        fs.readFile(filePath, "utf8", (err, content) => {
          if (err) return checkNext(i + 1);
          const line = content.split("\n").find(l => l.includes(cardNumber));
          if (line) foundLine = line.trim();
          checkNext(i + 1);
        });
      };

      const printOnA4 = (text) => {
        console.log("ПЕЧАТЬ НА A4:", text);

        const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  @page { margin: 2cm; }
  body { font-family: Arial, sans-serif; text-align: center; padding-top: 8cm; font-size: 48px; font-weight: bold; color: #003087; }
</style>
</head>
<body>
  <div>${text.replace(/</g, "&lt;")}</div>
  <br><br><br><br>
  <div style="font-size:42px;color:#006400">КАРТА УСПЕШНО ВЫДАНА</div>
</body></html>`;

        const tempFile = path.join(os.tmpdir(), `print_${Date.now()}_${crypto.randomUUID().slice(0,8)}.html`);
        fs.writeFileSync(tempFile, html, "utf8");

        const printCmd = process.platform === "win32"
          ? `powershell -Command "Start-Process '${tempFile}' -Verb Print"`
          : `lp "${tempFile}"`;

        exec(printCmd, (err) => {
          if (err) console.error("Ошибка печати:", err);
          else console.log("Успешно отправлено на принтер");
          setTimeout(() => fs.unlink(tempFile, () => {}), 15000);
        });
      };

      checkNext(0);
    });
  });
});

// === ВАЖНО: Динамическая отдача mobile-scan.html (чтобы sid всегда был актуальным) ===
app.get("/mobile-scan.html", (req, res) => {
  const sid = req.query.sid;

  if (!sid || !sessions.has(sid)) {
    return res.status(400).send(`
      <h2 style="text-align:center;margin-top:20vh;color:#fff;background:#003087;height:100vh;padding-top:20vh;font-family:Arial,sans-serif">
        Ссылка устарела или повреждена<br><br>
        <button onclick="location.reload()" style="padding:15px 30px;font-size:18px;border:none;border-radius:10px;cursor:pointer">
          Попробовать снова
        </button>
      </h2>`);
  }

  let html = fs.readFileSync(path.join(__dirname, "public", "mobile-scan.html"), "utf8");

  // Жёстко вшиваем правильный sid (чтобы не зависеть от query-параметра)
  html = html.replace(
    /const sessionId = urlParams\.get\('sid'\);/,
    `const sessionId = "${sid}";`
  );

  res.type("html").send(html);
});

// Простая заглушка для /mobile (если кто-то зайдёт напрямую)
app.get("/mobile", (req, res) => res.redirect("/"));

// === Очистка старых сессий ===
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.timestamp > 10 * 60 * 1000) { // 10 минут
      sessions.delete(k);
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`http://localhost:${PORT}`);
});