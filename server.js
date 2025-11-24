const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const QRCode = require("qrcode");
const crypto = require("crypto");
const os = require("os");
const path = require("path");

const app = express();
app.use(express.json());

// ← ВАЖНО: обслуживаем папку public + явные маршруты
app.use(express.static(path.join(__dirname, "public")));

// Эти две строки решают проблему 404 навсегда
app.get("/mobile", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "mobile.html"));
});
app.get("/mobile-scan.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "mobile-scan.html"));
});

// БД
const db = new sqlite3.Database(path.join(__dirname, "db.sqlite"), (err) => {
  err ? console.error("БД ошибка:", err.message) : console.log("База подключена");
});

const sessions = new Map();

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    code TEXT PRIMARY KEY, card TEXT, first_name TEXT, last_name TEXT
  )`);
  db.run(`INSERT OR IGNORE INTO clients VALUES ('12345', '1111-2222-3333-4444', 'Алексей', 'Смирнов')`);
});

// Автоопределение IP
function getIP() {
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets) if (net.family === 'IPv4' && !net.internal) return net.address;
  }
  return "127.0.0.1";
}
const IP = getIP();

// Касса
app.get("/", (req, res) => {
  const sid = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  sessions.set(sid, { scanned: false, code: null });

  QRCode.toDataURL(JSON.stringify({ sessionId: sid }), { width: 500 }, (err, url) => {
    if (err) return res.send("QR error");
    res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Касса</title>
    <style>body{font-family:Arial;text-align:center;background:#f5f5f5;padding:50px}
    .qr{background:#fff;padding:30px;border-radius:20px;box-shadow:0 10px 40px #0002}</style></head><body>
    <h1>Покажите клиенту QR-код</h1>
    <div class="qr"><img src="${url}"></div><br><br>
    <button onclick="location.reload()" style="padding:15px 30px;font-size:18px">Новый QR</button>
    <div id="s" style="margin:30px;font-size:22px">Ожидаем сканирование...</div>
    <script>
    const sid="${sid}";
    setInterval(()=>{fetch("/s/"+sid).then(r=>r.json()).then(d=>{
      if(d.success) document.getElementById("s").innerHTML="<h2 style='color:green'>ГОТОВО!<br>"+d.first_name+" "+d.last_name+"<br>Карта: "+d.card+"</h2>";
    })},2000);
    </script></body></html>`);
  });
});

app.get("/s/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({error:"expired"});
  if (s.scanned) {
    db.get("SELECT * FROM clients WHERE code=?", [s.code], (_, r) => 
      res.json(r ? {success:true, ...r} : {error:"no"}));
  } else res.json({pending:true});
});

app.post("/api/scan", (req, res) => {
  const {sessionId, customerCode} = req.body;
  const s = sessions.get(sessionId);
  if (!s) return res.json({error:"bad"});
  const code = customerCode.trim();
  db.get("SELECT * FROM clients WHERE code=?", [code], (err, row) => {
    if (row) { s.scanned = true; s.code = code; res.json({success:true, data:row}); }
    else res.json({error:"Клиент не найден"});
  });
});

app.listen(3000, "0.0.0.0", () => {
  console.log("Сервер запущен!");
  console.log("Касса → http://localhost:3000");
  console.log(`Телефон → http://${IP}:3000/mobile`);
});