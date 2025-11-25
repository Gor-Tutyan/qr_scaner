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

const RESULT_FILE = path.join(__dirname, "public", "prints", "PrintResult.CPS2");
if (!fs.existsSync(RESULT_FILE)) {
  fs.writeFileSync(RESULT_FILE, "", "utf8");
  console.log("Создан PrintResult.CPS2");
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    client_code TEXT PRIMARY KEY,
    card_number TEXT,
    first_name TEXT,
    last_name TEXT
  )`);
});

// === ГЛАВНАЯ СТРАНИЦА ===
app.get("/", async (req, res) => {
  const sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  sessions.set(sessionId, {
    scanned: false,
    customerCode: null,
    timestamp: Date.now(),
    selection: null
  });

  const mobileUrl = `${req.protocol}://${req.get("host")}/mobile-scan.html?sid=${sessionId}`;
  let qrUrl = "";
  try {
    qrUrl = await QRCode.toDataURL(mobileUrl, { width: 500, margin: 2 });
  } catch (e) {
    console.error("QR error:", e);
  }

  res.send(`<!DOCTYPE html>
<html lang="hy">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unibank — Մոմենտալ քարտ</title>

<style>
  body{font-family:system-ui,Arial,sans-serif;background:#f8f9fa;color:#333;margin:0;padding:20px;text-align:center}
  .btn-big{background:#003087;color:white;border:none;border-radius:20px;padding:30px;font-size:28px;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,0.2);width:90%;max-width:500px;margin:80px auto;display:block}
  .btn-big:hover{background:#00205b}
  .step{display:none;background:white;border-radius:20px;padding:30px;margin:20px auto;box-shadow:0 10px 40px rgba(0,0,0,0.1);max-width:1000px}
  h1,h2{color:#003087;margin:20px 0}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}
  .card{border-radius:16px;overflow:hidden;box-shadow:0 8px 25px rgba(0,0,0,0.15);cursor:pointer;transition:.3s;background:white}
  .card:hover{transform:translateY(-10px)}
  .card img{width:100%;height:150px;object-fit:cover}
  .card div{padding:16px;background:#003087;color:white;font-weight:bold}
  .selected{border:5px solid #003087}
  .currency-grid{display:flex;flex-wrap:wrap;gap:15px;justify-content:center;margin:40px 0}
  .currency-btn{background:#003087;color:white;padding:16px 32px;border-radius:12px;font-size:20px;cursor:pointer}
  .currency-btn.selected{background:#00205b}
  #qr-area{display:none;background:white;padding:50px;border-radius:20px;box-shadow:0 15px 50px rgba(0,0,0,0.2);max-width:600px;margin:40px auto}
</style>

</head>
<body>

<button class="btn-big" onclick="document.getElementById('step1').style.display='block';this.style.display='none'">
  Ստանալ մոմենտալ քարտ
</button>

<div id="step1" class="step"><h1>Ընտրեք բրենդը</h1><div class="grid" id="brands"></div></div>
<div id="step2" class="step"><h1 id="brand-title"></h1><div class="grid" id="products"></div></div>

<div id="step3" class="step">
  <h1 id="product-title"></h1>
  <h2>Ընտրեք դիզայնը</h2>
  <div class="grid" id="designs"></div>
  <h2>Ընտրեք արժույթը</h2>
  <div class="currency-grid" id="currencies"></div>
  <br>
  <button onclick="confirmChoice()" style="padding:16px 60px;font-size:22px;background:#003087;color:white;border:none;border-radius:12px;cursor:pointer">
    Շարունակել
  </button>
</div>

<div id="qr-area">
  <h2>Ցուցադրեք QR-կոդը հաճախորդին</h2>
  <img src="${qrUrl}" style="max-width:420px"><br><br>
  <div id="info" style="font-size:20px;font-weight:bold;line-height:1.8"></div><br>
  <button onclick="location.reload()" style="padding:15px 40px;font-size:18px">Նոր հաճախորդ</button>
</div>

<script>
  const sid = "${sessionId}";
  let cfg = null;
  let sel = {brand:null, product:null, designId:null, currency:null};

  fetch("/config/cards.json")
    .then(r => r.json())
    .then(c => {
      cfg = c;
      document.getElementById("brands").innerHTML =
        Object.keys(cfg.brands).map(k => {
          const b = cfg.brands[k];
          return \`
            <div class="card" onclick="chooseBrand('\${k}')">
              <img src="\${b.icon}" onerror="this.src='/icons/fallback.png'">
              <div>\${b.name}</div>
            </div>
          \`;
        }).join("");
    });

  function chooseBrand(k) {
    sel.brand = k;
    const b = cfg.brands[k];
    document.getElementById("brand-title").textContent = b.name;
    document.getElementById("step1").style.display = "none";
    document.getElementById("step2").style.display = "block";

    document.getElementById("products").innerHTML =
      Object.keys(b.products).map(p => {
        return \`
          <div class="card" onclick="chooseProduct('\${p}')">
            <div style="padding:60px 20px;font-size:24px">\${b.products[p].name}</div>
          </div>
        \`;
      }).join("");
  }

  function chooseProduct(p) {
    sel.product = p;
    const brand = cfg.brands[sel.brand];
    const prod = brand.products[p];

    document.getElementById("product-title").textContent =
      brand.name + " " + prod.name;

    document.getElementById("step2").style.display = "none";
    document.getElementById("step3").style.display = "block";

    // Designs
    document.getElementById("designs").innerHTML =
      prod.designs.map(id => {
        const d = cfg.designs[id];
        return \`
          <div class="card" onclick="selectDesign(\${id}, this)">
            <img src="\${d.image}" onerror="this.src='/cards/fallback.jpg'">
            <div>\${d.name}<br><small>\${d.designCode}</small></div>
          </div>
        \`;
      }).join("");

    // Currencies
    document.getElementById("currencies").innerHTML =
      prod.currencies.map(cur => \`
        <div class="currency-btn"
             onclick="sel.currency='\${cur}';document.querySelectorAll('.currency-btn').forEach(x=>x.classList.remove('selected'));this.classList.add('selected')">
          \${cur}
        </div>
      \`).join("");
  }

  function selectDesign(id, el) {
    sel.designId = id;
    document.querySelectorAll("#designs .card").forEach(c => c.classList.remove("selected"));
    el.classList.add("selected");
  }

  function confirmChoice() {
    if (!sel.designId) return alert("Ընտրեք դիզայնը");
    if (!sel.currency) return alert("Ընտրեք արժույթը");

    const design = cfg.designs[sel.designId];
    const brandName = cfg.brands[sel.brand].name;
    const prodName = cfg.brands[sel.brand].products[sel.product].name;

    fetch("/api/set-selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sid,
        selection: {
          brand: sel.brand,
          product: sel.product,
          designId: sel.designId,
          designCode: design.designCode,
          currency: sel.currency
        }
      })
    });

    document.getElementById("info").innerHTML = \`
      <b>\${brandName} \${prodName}</b><br>
      Դիզայն՝ \${design.name} (\${design.designCode})<br>
      Արժույթ՝ \${sel.currency}
    \`;

    document.getElementById("step3").style.display = "none";
    document.getElementById("qr-area").style.display = "block";

    const poll = setInterval(() => {
      fetch("/api/status/" + sid)
        .then(r => r.json())
        .then(d => {
          if (d.success) {
            clearInterval(poll);
            const name = encodeURIComponent(d.first_name + " " + d.last_name);
            location.href =
              \`/card-result.html?name=\${name}&number=\${d.card_number}&design=\${sel.designId}&code=\${design.designCode}\`;
          }
        });
    }, 1500);
  }
</script>

</body>
</html>`);
});

// === API: сохранение выбора ===
app.post("/api/set-selection", (req, res) => {
  const { sessionId, selection } = req.body;
  if (sessions.has(sessionId)) {
    sessions.get(sessionId).selection = selection;
  }
  res.json({ ok: true });
});

// === API: статус ===
app.get("/api/status/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !s.scanned || !s.customerCode) return res.json({ pending: true });

  db.get("SELECT * FROM clients WHERE client_code = ?", [s.customerCode], (err, row) => {
    if (err || !row) return res.json({ pending: true });

    res.json({
      success: true,
      first_name: row.first_name || "ԱՆՈՒՆ",
      last_name: row.last_name || "ԱԶԳԱՆՈՒՆ",
      card_number: row.card_number || "4111111111111111"
    });
  });
});

// === API: обработка сканирования ===
app.post("/api/scan", (req, res) => {
  const { sessionId, customerCode } = req.body;
  if (!sessionId || !customerCode) return res.json({ success: false });

  const session = sessions.get(sessionId);
  if (!session) return res.json({ success: false });

  const code = customerCode.toString().trim().replace(/\D/g, "");
  if (code.length < 4) return res.json({ success: false });

  db.get("SELECT * FROM clients WHERE client_code = ?", [code], (err, row) => {
    if (err || !row) return res.json({ success: false });

    session.scanned = true;
    session.customerCode = code;

    const cardNumber = (row.card_number || "").replace(/\s/g, "").trim();
    const sel = session.selection;
    let line = null;

    try {
      const files = fs.readdirSync(path.join(__dirname, "public", "prints"));
      for (const file of files) {
        if (!file.toLowerCase().endsWith(".cps2")) continue;
        const content = fs.readFileSync(path.join(__dirname, "public", "prints", file), "utf8");
        const found = content.split("\n").find(l => l.includes(cardNumber) && l.trim());
        if (found) {
          line = found.trim();
          break;
        }
      }
    } catch (e) {}

    if (!line) {
      const name = `${row.first_name || "ԱՆՈՒՆ"} ${row.last_name || "ԱԶԳԱՆՈՒՆ"}`.trim();
      const now = new Date().toISOString().slice(0,19).replace("T", " ");
      const design = sel?.designCode || "UNKNOWN";
      const cur = sel?.currency || "AMD";

      line = `${cardNumber}\t${name}\t${now}\t${design}\t${cur}\tISSUED`;
    }

    fs.appendFile(RESULT_FILE, line + "\n", "utf8", (err) => {
      if (err) console.error("Ошибка записи:", err);
      res.json({ success: true });
    });
  });
});

// === Служебные роуты ===
app.get("/mobile-scan.html", (req, res) => {
  const sid = req.query.sid;
  if (sid && /^[a-z0-9]{32}$/.test(sid)) {
    res.sendFile(path.join(__dirname, "public", "mobile-scan.html"));
  } else res.status(400).send("Bad sid");
});

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

// === SERVER START ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Unibank моментальная выдача запущена!");
  console.log(`Ссылка на результат: http://localhost:${PORT}/PrintResult.CPS2`);
});
