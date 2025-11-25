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

// ПУТЬ К ФАЙЛУ В GIT — ВСЕГДА ВИДЕН В РЕПОЗИТОРИИ
const RESULT_FILE = path.join(__dirname, "public", "prints", "PrintResult.CPS2");

// Создаём папку и файл при старте
fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
if (!fs.existsSync(RESULT_FILE)) {
  fs.writeFileSync(RESULT_FILE, "", "utf8");
  console.log("Создан: public/prints/PrintResult.CPS2");
}

// База данных
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    client_code TEXT PRIMARY KEY,
    card_number TEXT,
    first_name TEXT,
    last_name TEXT
  )`);
});

// Главная страница кассы
app.get("/", (req, res) => {
  const sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  sessions.set(sessionId, { scanned: false, customerCode: null, timestamp: Date.now(), cardDesign: null });

  const mobileUrl = `${req.protocol}://${req.get("host")}/mobile-scan.html?sid=${sessionId}`;

  QRCode.toDataURL(mobileUrl, { width: 500, margin: 2 }, (err, qrUrl) => {
    if (err) return res.status(500).send("QR Error");

    res.send(`<!DOCTYPE html>
<html lang="hy"><head><meta charset="UTF-8"><title>Unibank — Քարտի տրամադրում</title>
<style>
  body{font-family:Arial,sans-serif;background:#f8f9fa;margin:0;padding:20px;text-align:center}
  h1{font-size:32px;color:#003087;margin:40px 0}
  .designs{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:30px;max-width:1200px;margin:auto}
  .card-btn{border-radius:20px;overflow:hidden;box-shadow:0 12px 35px rgba(0,0,0,.25);cursor:pointer;transition:.3s;background:white}
  .card-btn:hover{transform:translateY(-12px);box-shadow:0 25px 50px rgba(0,0,0,.3)}
  .card-btn img{width:100%}
  .card-name{background:#003087;color:#fff;padding:16px;font-size:22px;font-weight:bold}
  #qr-area{display:none;margin:50px auto;padding:40px;background:white;border-radius:25px;box-shadow:0 15px 50px rgba(0,0,0,.2);max-width:650px}
</style></head><body>

<h1>Ընտրեք քարտի դիզայնը</h1>
<div class="designs">
  <div class="card-btn" onclick="choose(1)"><img src="/cards/card1.png"><div class="card-name">Դիզայն 1</div></div>
  <div class="card-btn" onclick="choose(2)"><img src="/cards/card2.png"><div class="card-name">Դիզայն 2</div></div>
  <div class="card-btn" onclick="choose(3)"><img src="/cards/card3.png"><div class="card-name">Դիզայն 3</div></div>
  <div class="card-btn" onclick="choose(4)"><img src="/cards/card4.png"><div class="card-name">Դիզայն 4</div></div>
</div>

<div id="qr-area">
  <h2>Ցուցադրեք QR-կոդը հաճախորդին</h2>
  <img src="${qrUrl}" style="max-width:420px"><br><br>
  <strong>Դիզայն՝ <span id="sel">-</span></strong><br><br>
  <button onclick="location.reload()">Նոր հաճախորդ</button>
</div>

<script>
  const sid = "${sessionId}";
  function choose(d) {
    fetch("/api/set-design", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({sessionId:sid,design:d})});
    document.querySelector(".designs").style.display="none";
    document.getElementById("qr-area").style.display="block";
    document.getElementById("sel").textContent = d;
    const timer = setInterval(()=> {
      fetch("/api/status/"+sid).then(r=>r.json()).then(data=>{
        if(data.success){
          clearInterval(timer);
          const name = (data.first_name + " " + data.last_name).toUpperCase();
          const number = data.card_number || "4111111111111111111";
          const design = data.design || 1;
          location.href = "/card-result.html?name="+encodeURIComponent(name)+"&number="+number+"&design="+design;
        }
      });
    }, 1500);
  }
</script>
</body></html>`);
  });
});

app.post("/api/set-design", (req, res) => {
  const { sessionId, design } = req.body;
  if (sessions.has(sessionId)) sessions.get(sessionId).cardDesign = Number(design);
  res.json({ ok: true });
});

app.get("/api/status/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !s.scanned || !s.customerCode) return res.json({ pending: true });

  db.get("SELECT * FROM clients WHERE client_code = ?", [s.customerCode], (err, row) => {
    if (err || !row) return res.json({ error: "Not found" });
    res.json({
      success: true,
      first_name: row.first_name || "ԱՆՈՒՆ",
      last_name: row.last_name || "ԱԶԳԱՆՈ",
      card_number: row.card_number || "4111111111111111",
      design: s.cardDesign || 1
    });
  });
});

// ГЛАВНОЕ: ЗАПИСЬ В GIT + ОРИГИНАЛЬНАЯ СТРОКА
app.post("/api/scan", (req, res) => {
  const { sessionId, customerCode } = req.body;
  if (!sessionId || !customerCode) return res.json({ error: "Нет данных" });

  const session = sessions.get(sessionId);
  if (!session) return res.json({ error: "Сессия истекла" });

  const code = customerCode.toString().trim().replace(/\D/g, "");
  if (code.length < 4) return res.json({ error: "Կոդը շատ կարճ է" });

  db.get("SELECT * FROM clients WHERE client_code = ?", [code], (err, row) => {
    if (err || !row) {
      console.log("Клиент не найден:", code);
      return res.json({ error: "Հաճախորդը չի գտնվել" });
    }

    session.scanned = true;
    session.customerCode = code;

    const cardNumber = (row.card_number || "").replace(/\s/g, "").trim();

    let lineToWrite = null;

    // Ищем оригинальную строку в .cps2 файлах
    const printsDir = path.join(__dirname, "public", "prints");
    try {
      const files = fs.readdirSync(printsDir);
      for (const file of files) {
        if (!file.toLowerCase().endsWith(".cps2")) continue;
        const content = fs.readFileSync(path.join(printsDir, file), "utf8");
        const foundLine = content.split("\n").find(l => l.includes(cardNumber) && l.trim() !== "");
        if (foundLine) {
          lineToWrite = foundLine.trim();
          console.log(`Найдена оригинальная строка в ${file}: ${lineToWrite}`);
          break;
        }
      }
    } catch (e) {
      console.log("Папка prints недоступна или пуста");
    }

    // Если не нашли — создаём красивую строку
    if (!lineToWrite) {
      const name = `${row.first_name || "ԱՆՈՒՆ"} ${row.last_name || "ԱԶԳԱՆՈՒՆ"}`.trim();
      const date = new Date().toISOString().slice(0,19).replace("T", " ");
      lineToWrite = `${cardNumber}\t${name}\t${date}\tISSUED`;
    }

    // ЗАПИСЫВАЕМ ПРЯМО В GIT
    fs.appendFile(RESULT_FILE, lineToWrite + "\n", "utf8", (err) => {
      if (err) {
        console.error("Ошибка записи в Git:", err.message);
        return res.json({ success: true, saved: false });
      }

      console.log("УСПЕШНО! Добавлено в Git → public/prints/PrintResult.CPS2");
      console.log("→", lineToWrite);

      res.json({
        success: true,
        saved: true,
        line: lineToWrite,
        file: "prints/PrintResult.CPS2"
      });
    });
  });
});

app.get("/mobile-scan.html", (req, res) => {
  const sid = req.query.sid;
  if (sid && /^[a-z0-9]{32}$/.test(sid)) {
    res.sendFile(path.join(__dirname, "public", "mobile-scan.html"));
  } else {
    res.status(400).send("Неверный sid");
  }
});

app.get("/mobile", (req, res) => res.redirect("/"));

// Доступ к файлу через браузер
app.get("/PrintResult.CPS2", (req, res) => {
  res.type("text/plain; charset=utf-8");
  res.sendFile(RESULT_FILE);
});

// Очистка старых сессий
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.timestamp > 600000) sessions.delete(k);
  }
}, 300000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Unibank сервер запущен!");
  console.log(`PrintResult.CPS2 → https://твой-сайт.onrender.com/PrintResult.CPS2`);
  console.log(`Файл в Git → public/prints/PrintResult.CPS2`);
});