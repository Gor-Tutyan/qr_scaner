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

// ──────────────────────────────────────────────────────────────
// ВАЖНО: где будет реально храниться файл (надёжное место)
// ──────────────────────────────────────────────────────────────
const REAL_RESULT_FILE = "/tmp/PrintResult.CPS2";                     // ← надёжно
const PUBLIC_RESULT_FILE = path.join(__dirname, "public", "PrintResult.CPS2"); // ← для совместимости

// Создаём симлинк при старте сервера (чтобы принтер видел старый путь)
function createSymlink() {
  fs.unlink(PUBLIC_RESULT_FILE, () => { // удаляем старый линк/файл, если был
    fs.symlink(REAL_RESULT_FILE, PUBLIC_RESULT_FILE, (err) => {
      if (err) {
        console.log("Не удалось создать симлинк public/PrintResult.CPS2 → /tmp/PrintResult.CPS2");
        console.log("Придётся использовать прямой путь /tmp/PrintResult.CPS2");
      } else {
        console.log("Симлинк успешно создан: public/PrintResult.CPS2 → /tmp/PrintResult.CPS2");
      }
    });
  });
}

// Гарантируем существование /tmp файла при старте
if (!fs.existsSync(REAL_RESULT_FILE)) {
  fs.writeFileSync(REAL_RESULT_FILE, "", "utf8");
  console.log("Создан пустой /tmp/PrintResult.CPS2");
}
createSymlink();

// ──────────────────────────────────────────────────────────────
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    client_code TEXT PRIMARY KEY,
    card_number TEXT,
    first_name TEXT,
    last_name TEXT
  )`);
});

// =======================

// ======================= ГЛАВНАЯ СТРАНИЦА КАССЫ =======================
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
  h1{margin:40px 0 50px;font-size:32px;color:#003087;font-weight:bold}
  .designs{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:30px;max-width:1200px;margin:0 auto}
  .card-btn{border-radius:20px;overflow:hidden;box-shadow:0 12px 35px rgba(0,0,0,0.25);cursor:pointer;transition:.3s;background:white}
  .card-btn:hover{transform:translateY(-12px);box-shadow:0 25px 50px rgba(0,0,0,0.3)}
  .card-btn img{width:100%;display:block}
  .card-name{background:#003087;color:#fff;padding:16px;font-size:22px;font-weight:bold}
  #qr-area{display:none;margin:50px auto;padding:40px;background:white;border-radius:25px;box-shadow:0 15px 50px rgba(0,0,0,0.2);max-width:650px}
  button{background:#003087;color:white;padding:16px 40px;font-size:20px;border:none;border-radius:15px;cursor:pointer;margin:15px}
</style></head><body>

<h1>Ընտրեք հաճախորդի քարտի դիզայնը</h1>
<div class="designs">
  <div class="card-btn" onclick="choose(1)"><img src="/cards/card1.png"><div class="card-name">Դիզայն 1</div></div>
  <div class="card-btn" onclick="choose(2)"><img src="/cards/card2.png"><div class="card-name">Դիզայն 2</div></div>
  <div class="card-btn" onclick="choose(3)"><img src="/cards/card3.png"><div class="card-name">Դիզայն 3</div></div>
  <div class="card-btn" onclick="choose(4)"><img src="/cards/card4.png"><div class="card-name">Դիզայն 4</div></div>
</div>

<div id="qr-area">
  <h2>Ցուցադրեք QR-կոդը հաճախորդին</h2>
  <img src="${qrUrl}" style="width:100%;max-width:420px;margin:20px">
  <p><strong>Ընտրված դիզայն՝</strong> <span id="sel">-</span></p>
  <div id="status">Սպասում ենք հաճախորդի հաստատմանը...</div>
  <button onclick="location.reload()">Նոր հաճախորդ</button>
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
       const number = (data.card_number || "4111111111111111");
       const design = data.design || 1;
       location.href = "/card-result.html?name="+encodeURIComponent(name)+"&number="+encodeURIComponent(number)+"&design="+design;
     }
   }), 1500);
 }
</script>
</body></html>`);
  });
});

// Сохранение выбранного дизайна
app.post("/api/set-design", (req, res) => {
  const { sessionId, design } = req.body;
  if (sessions.has(sessionId)) sessions.get(sessionId).cardDesign = Number(design);
  res.json({ ok: true });
});

// Статус для кассы (после подтверждения клиентом)
app.get("/api/status/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !s.scanned || !s.customerCode) return res.json({ pending: true });

  db.get("SELECT * FROM clients WHERE client_code = ?", [s.customerCode], (err, row) => {
    if (!row) return res.json({ error: "Հաճախորդը չի գտնվել" });
    res.json({
      success: true,
      first_name: row.first_name || "ԱՆՈՒՆ",
      last_name: row.last_name || "ԱԶԳԱՆՈՒՆ",
      card_number: row.card_number || "4111111111111111",
      design: s.cardDesign || 1
    });
  });
});

// ======================= СКАНИРОВАНИЕ + ГАРАНТИРОВАННАЯ ЗАПИСЬ =======================
app.post("/api/scan", (req, res) => {
  const { sessionId, customerCode } = req.body;
  if (!sessionId || !customerCode) return res.json({ error: "Տվյալներ չկան" });

  const s = sessions.get(sessionId);
  if (!s) return res.json({ error: "Սեսիան ավարտվել է" });

  const code = customerCode.toString().trim().replace(/\D/g, "");
  if (code.length < 4) return res.json({ error: "Կոդը շատ կարճ է" });

  db.get("SELECT * FROM clients WHERE client_code = ?", [code], (err, row) => {
    if (err || !row) {
      console.log("Հաճախորդը ՉԻ գտնվել կոդով:", code);
      return res.json({ error: "Հաճախորդը չի գտնվել" });
    }

    // Отмечаем успешное подтверждение
    s.scanned = true;
    s.customerCode = code;

    const fullName = `${row.first_name || "ԱՆՈՒՆ"} ${row.last_name || "ԱԶԳԱՆՈՒՆ"}`.trim();
    const cleanCardNumber = (row.card_number || "4111111111111111").replace(/\s/g, "");
    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const line = `${cleanCardNumber}\t${fullName}\t${timestamp}`;

    console.log(`ՀԱՋՈՂՈՒԹՅՈՒՆ! Քարտը տրամադրվել է → ${fullName} | ${cleanCardNumber}`);

    // Записываем в /tmp (надёжно) + обновляем симлинк
    fs.appendFile(REAL_RESULT_FILE, line + "\n", "utf8", (err) => {
      if (err) {
        console.error("ՍԽԱԼ գրելիս /tmp/PrintResult.CPS2:", err.message);
        return res.json({ success: true, saved: false });
      }

      console.log("→ Записано в PrintResult.CPS2:", line);
      createSymlink(); // обновляем симлинк на случай, если он сломался

      res.json({ 
        success: true, 
        saved: true, 
        file: "PrintResult.CPS2",
        line: line
      });
    });
  });
});

// Мобильные страницы
app.get("/mobile-scan.html", (req, res) => {
  const sid = req.query.sid;
  if (sid && /^[a-z0-9]{32}$/.test(sid)) {
    res.sendFile(path.join(__dirname, "public", "mobile-scan.html"));
  } else {
    res.status(400).send("Սխալ sid");
  }
});

app.get("/mobile", (req, res) => res.redirect("/"));

// Прямой доступ к файлу (на всякий случай)
app.get("/PrintResult.CPS2", (req, res) => {
  res.sendFile(REAL_RESULT_FILE, (err) => {
    if (err) res.status(404).send("Файл ещё не создан");
  });
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
  console.log("Unibank սերվերը գործարկվել է!");
  console.log(`http://localhost:${PORT}`);
  console.log(`Файл результата: ${REAL_RESULT_FILE}`);
  console.log(`Публичный путь: /PrintResult.CPS2`);
});