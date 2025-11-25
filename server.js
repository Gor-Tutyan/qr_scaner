const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const QRCode = require("qrcode");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// База
const isProduction = process.env.RENDER || process.env.NODE_ENV === "production";
const dbPath = isProduction ? "/tmp/database.sqlite" : path.join(__dirname, "db", "database.sqlite");
if (!isProduction) fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new sqlite3.Database(dbPath);
const sessions = new Map();

// ФАЙЛ В GIT — ВИДИМЫЙ НАВСЕГДА
const RESULT_FILE = path.join(__dirname, "public", "prints", "PrintResult.CPS2");
if (!fs.existsSync(RESULT_FILE)) {
  fs.writeFileSync(RESULT_FILE, "", "utf8");
  console.log("Создан public/prints/PrintResult.CPS2");
}

// Таблица клиентов
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    client_code TEXT PRIMARY KEY,
    card_number TEXT,
    first_name TEXT,
    last_name TEXT
  )`);
});

// Главная страница
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
  .card-btn:hover{transform:translateY(-12px)}
  .card-btn img{width:100%}
  .card-name{background:#003087;color:#fff;padding:16px;font-size:22px;font-weight:bold}
  #qr-area{display:none;margin:50px auto;padding:40px;background:white;border-radius:25px;max-width:650px}
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
    const t = setInterval(()=>{
      fetch("/api/status/"+sid).then(r=>r.json()).then(data=>{
        if(data.success){
          clearInterval(t);
          const name = (data.first_name + " " + data.last_name).toUpperCase();
          const number = data.card_number || "4111111111111111";
          const design = data.design || 1;
          location.href = "/card-result.html?name="+encodeURIComponent(name)+"&number="+number+"&design="+design;
        }
      }).catch(()=>{});
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
  if (!s || !s.scanned) return res.json({ pending: true });

  db.get("SELECT * FROM clients WHERE client_code = ?", [s.customerCode], (err, row) => {
    if (err || !row) return res.json({ pending: true });
    res.json({
      success: true,
      first_name: row.first_name || "ԱՆՈՒՆ",
      last_name: row.last_name || "ԱԶԳԱՆՈՒՆ",
      card_number: row.card_number || "4111111111111111",
      design: s.cardDesign || 1
    });
  });
});

// ГЛАВНОЕ — РАБОЧАЯ ЗАПИСЬ В GIT
app.post("/api/scan", (req, res) => {
  const { sessionId, customerCode } = req.body;
  if (!sessionId || !customerCode) return res.json({ success: false, error: "Нет данных" });

  const session = sessions.get(sessionId);
  if (!session) return res.json({ success: false, error: "Сессия истекла" });

  const code = customerCode.toString().trim().replace(/\D/g, "");
  if (code.length < 4) return res.json({ success: false, error: "Կոդը շատ կարճ է" });

  db.get("SELECT * FROM clients WHERE client_code = ?", [code], (err, row) => {
    if (err || !row) return res.json({ success: false, error: "Հաճախորդը չի գտնվել" });

    session.scanned = true;
    session.customerCode = code;

    const cardNumber = (row.card_number || "").replace(/\s/g, "").trim();
    let line = null;

    // Ищем оригинальную строку
    try {
      const files = fs.readdirSync(path.join(__dirname, "public", "prints"));
      for (const file of files) {
        if (!file.toLowerCase().endsWith(".cps2")) continue;
        const content = fs.readFileSync(path.join(__dirname, "public", "prints", file), "utf8");
        const found = content.split("\n").find(l => l.includes(cardNumber) && l.trim() !== "");
        if (found) {
          line = found.trim();
          console.log(`Найдена строка в ${file}: ${line}`);
          break;
        }
      }
    } catch (e) {
      console.log("Папка prints не найдена или пустая");
    }

    // Если не нашли — своя строка
    if (!line) {
      const name = `${row.first_name || "ԱՆՈՒՆ"} ${row.last_name || "ԱԶԳԱՆՈՒՆ"}`.trim();
      const now = new Date().toISOString().slice(0,19).replace("T", " ");
      line = `${cardNumber}\t${name}\t${now}\tISSUED`;
    }

    // Записываем в Git
    fs.appendFile(RESULT_FILE, line + "\n", "utf8", (err) => {
      if (err) {
        console.error("Ошибка записи:", err);
        return res.json({ success: false, error: "Не удалось сохранить" });
      }
      console.log("УСПЕШНО добавлено в PrintResult.CPS2");
      res.json({ success: true, line: line });
    });
  });
});

// Остальное
app.get("/mobile-scan.html", (req, res) => {
  const sid = req.query.sid;
  if (sid && /^[a-z0-9]{32}$/.test(sid)) {
    res.sendFile(path.join(__dirname, "public", "mobile-scan.html"));
  } else {
    res.status(400).send("Bad sid");
  }
});

app.get("/PrintResult.CPS2", (req, res) => {
  res.type("text/plain; charset=utf-8");
  res.sendFile(RESULT_FILE);
});

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.timestamp > 600000) sessions.delete(k);
  }
}, 300000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Сервер запущен!");
  console.log(`PrintResult.CPS2 → https://qr-scaner-3zae.onrender.com/PrintResult.CPS2`);
});