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

const RESULT_FILE = path.join(__dirname, "public", "printFile", "PrintResult.CPS2");
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

// === КРАСИВОЕ ЛОГИРОВАНИЕ ===
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getTime() {
  return new Date().toLocaleString("ru-RU", {
    timeZone: "Asia/Yerevan",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function log(message) {
  const timestamp = getTime();
  const dateStr = new Date().toISOString().slice(0,10); // 2025-12-04
  const line = `[${timestamp}] ${message}\n`;
  
  console.log(line.trim()); // в консоль
  
  // в файл по дням
  const logFile = path.join(LOG_DIR, `${dateStr}.log`);
  fs.appendFileSync(logFile, line, "utf8");
}

// При старте сервера
log("==========================================");
log("Сервер запущен — система выдачи карт Unibank");
log(`Результат → ${RESULT_FILE}`);
log("==========================================");
// === ЗАГРУЗКА КОНФИГУРАЦИИ КАРТ ПРИ СТАРТЕ ===
global.cardConfig = null;
const configPath = path.join(__dirname, "public", "config", "cards.json");

if (fs.existsSync(configPath)) {
  try {
    global.cardConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    log("Конфигурация cards.json успешно загружена");
  } catch (e) {
    log(`ОШИБКА при чтении cards.json → ${e.message}`);
  }
} else {
  log(`ПРЕДУПРЕЖДЕНИЕ | Файл cards.json НЕ НАЙДЕН по пути: ${configPath}`);
  log(`           Убедитесь, что файл лежит в public/config/cards.json`);
}


// === ГЛАВНАЯ СТРАНИЦА ===
app.get("/", async (req, res) => {
  const sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  log(`НОВАЯ СЕССИЯ | ID: ${sessionId.slice(0,8)}...`);
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
body {
  font-family: system-ui, Arial, sans-serif;
  background: #f8f9fa;
  color: #333;
  margin: 0;
  padding: 15px 20px;
  text-align: center;
}

/* Главные кнопки */
.btn-big {
  background: #003087;
  color: white;
  border: none;
  border-radius: 12px;
  padding: 10px 20px;
  font-size: 16px;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  width: auto;
  max-width: 90%;
  margin: 20px auto;
  display: inline-block;
  transition: 0.3s;
}
.btn-big:hover { background: #00205b; transform: translateY(-2px); }

/* Шаги */
.step {
  display: none;
  background: white;
  border-radius: 18px;
  padding: 30px;
  margin: 20px auto;
  box-shadow: 0 10px 40px rgba(0,0,0,0.1);
  max-width: 500px;
}

/* Заголовки */
h1 { color: #003087; font-size: 29px; margin: 10px 0 28px; font-weight: 700; }
h2 { color: #003087; font-size: 22px; margin: 35px 0 15px; }

/* Бренды */
#brands .grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); gap: 18px; }
#brands .card {
  height: 120px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  background: white;
  border-radius: 14px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.12);
  cursor: pointer;
  transition: .3s;
  margin: 15px 15px;
}
#brands .card:hover { transform: translateY(-8px); }
#brands .card img { max-height: 55px; width: auto; }
#brands .card div { margin-top: 8px; font-size: 17px; color: #003087; font-weight: 600; }

/* ────── КРАСИВЫЕ КНОПКИ ПРОДУКТОВ С ХОРОШИМ РАССТОЯНИЕМ ────── */
#products .grid {
  display: flex;
  flex-wrap: wrap;
  gap: 32px;               /* ← УВЕЛИЧЕННЫЙ ОТСТУП МЕЖДУ КНОПКАМИ */
  justify-content: center;
  margin: 40px 0;
  padding: 0 20px;
}

.nice-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  background: white;
  color: #003087;
  font-weight: 700;
  font-size: 19px;
  padding: 20px 36px;
  border-radius: 20px;
  box-shadow: 0 12px 32px rgba(0, 48, 135, 0.2);
  cursor: pointer;
  transition: all 0.35s ease;
  border: 2.5px solid transparent;
  min-width: 200px;
  flex: 0 1 280px;         /* чтобы не растягивались, но и не сжимались слишком */
  margin: 20px 20px;
}

.nice-btn:hover {
  transform: translateY(-10px);
  box-shadow: 0 20px 50px rgba(0, 48, 135, 0.32);
  background: #f0f7ff;
  border-color: #003087;
}

.nice-btn:active {
  transform: translateY(-4px);
}

.btn-logo {
  height: 44px;
  width: auto;
  filter: drop-shadow(0 2px 6px rgba(0,0,0,0.25));
}
  /* Контейнер кнопок на карточке продуктов */
#products .card .button-row {
  display: flex;
  justify-content: center;
  gap: 6px;
  padding: 6px;
}

/* Кнопки внутри карточки */
#products .card .button-row div {
  background: #003087;
  color: white;
  font-size: 13px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 8px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.2);
  text-align: center;
  cursor: pointer;
  min-width: 60px;
  max-width: 120px;
  width: auto;
  transition: background 0.3s, transform 0.2s;
}

#products .card .button-row div:hover {
  background: #001f5f;
  transform: translateY(-1px);
}

/* Дизайны */
#designs {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  justify-content: center;
}

#designs .card {
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 8px 25px rgba(0,0,0,0.14);
  transition: transform 0.3s, box-shadow 0.3s;
  cursor: pointer;
  background: white;
  border: 2px solid transparent;
  width: 180px;
  height: 220px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px;
}

#designs .card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 30px rgba(0,0,0,0.2);
}

#designs .card.selected {
  border: 2px solid #003087;
  transform: scale(1.02);
}

#designs .card img {
  width: 200px;
  height: auto;
  display: block;
  border-radius: 12px;
  background-color: #f9f9f9;
  object-fit: contain;
  margin-bottom: 10px;
}

#designs .card div {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  font-weight: 600;
  font-size: 14px;
  color: #003087;
}

#designs .card div small {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: #666;
}

/* Валюты */
.currency-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  justify-content: center;
  margin: 30px 0;
}
.currency-btn {
  background: #003087;
  color: white;
  padding: 8px 16px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  width: auto;
  min-width: 80px;
  max-width: 140px;
  transition: 0.3s;
}
.currency-btn:hover { background: #0040b0; }
.currency-btn.selected { 
  background: #00205b; 
  border: 2px solid #ffd700; 
  box-shadow: 0 0 15px rgba(255,215,0,0.4); 
}

/* Подтверждение */
button[onclick="confirmChoice()"] {
  padding: 8px 20px;
  font-size: 16px;
  background: #003087;
  color: white;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  width: auto;
  min-width: 100px;
  max-width: 180px;
  transition: 0.3s;
}
button[onclick="confirmChoice()"]:hover { background: #00205b; }

/* QR и информация */
#qr-area {
  display: none;
  background: white;
  padding: 40px;
  border-radius: 18px;
  box-shadow: 0 15px 50px rgba(0,0,0,0.18);
  max-width: 560px;
  margin: 40px auto;
}
#info {
  background: #eef5ff;
  padding: 18px;
  border-radius: 12px;
  border-left: 5px solid #003087;
  font-size: 18px;
  line-height: 1.6;
}
</style>
</head>
<body>

<button class="btn-big" onclick="document.getElementById('step1').style.display='block';this.style.display='none'">
  Ստանալ քարտ
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
  <button onclick="confirmChoice()" style="font-size:22px;background:#003087;color:white;border:none;border-radius:12px;cursor:pointer">
    Շարունակել
  </button>
</div>

<div id="qr-area">
  <h2>Սքանավորեք QR-կոդը</h2>
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

  document.getElementById("products").innerHTML = Object.keys(b.products).map(p => {
    const prod = b.products[p];
    return \`
      <div class="nice-btn" onclick="chooseProduct('\${p}')">
        <img src="\${b.icon}" class="btn-logo" onerror="this.src='/icons/fallback.png'">
        <span>\${prod.name}</span>
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
            const name = encodeURIComponent((d.first_name || "") + " " + (d.last_name || ""));
            const number = d.card_number || "4111111111111111";
            location.href = "/card-result.html?name=" + name + "&number=" + number + "&design=" + sel.designId;
          }
          else if (d.notReady || (d.error && d.error.includes("պատրաստ չէ"))) {
            clearInterval(poll);

            // Добавляем анимацию тряски один раз
            if (!document.getElementById("shake-style")) {
              const s = document.createElement("style");
              s.id = "shake-style";
              s.textContent = "@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-12px)}40%,80%{transform:translateX(12px)}}";
              document.head.appendChild(s);
            }

            document.getElementById("info").innerHTML =
              "<div style='background:#ffebee;color:#c62828;padding:22px;border-radius:16px;border:3px solid #e57373;font-weight:bold;font-size:22px;text-align:center;animation:shake 0.6s 2'>" +
              "Քարտը դեռ պատրաստ չէ" +
              "<br><small style='font-size:16px;display:block;margin-top:10px;opacity:0.9'>Համոզվեք, որ քարտը արդեն տպագրված է .CPS2 ֆայլում</small></div>" +
              "<br><button onclick='location.reload()' style='padding:14px 32px;font-size:18px;background:#c62828;color:white;border:none;border-radius:12px;cursor:pointer'>Փորձել կրկին</button>";
          }
        })
        .catch(() => {});
    }, 1500);
     }
</script>

</body>
</html>`);
});

// === API: сохранение выбора (С ЛОГИРОВАНИЕМ) ===
app.post("/api/set-selection", (req, res) => {
  const { sessionId, selection } = req.body;
  if (!sessions.has(sessionId)) {
    log(`ОШИБКА | Сессия ${sessionId.slice(0,8)}... не найдена при выборе продукта`);
    return res.json({ ok: false });
  }

  sessions.get(sessionId).selection = selection;

  const cfg = global.cardConfig;
  if (!cfg) return res.json({ ok: true });

// Безопасное получение названий
const brandName = cfg?.brands?.[selection.brand]?.name || selection.brand || "Неизвестный бренд";
const prodName = cfg?.brands?.[selection.brand]?.products?.[selection.product]?.name || selection.product || "Неизвестный продукт";
const designObj = cfg?.designs?.[selection.designId];
const designName = designObj?.name || "Без дизайна";
const designCode = selection.designCode || designObj?.designCode || "???";
  res.json({ ok: true });
});

// === API: статус ===
app.get("/api/status/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({ pending: true });

  if (s.notReady === true) {
    return res.json({ success: false, notReady: true, error: "Քարտը դեռ պատրաստ չէ" });
  }

  if (!s.scanned || !s.customerCode) {
    return res.json({ pending: true });
  }

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

// === API: сканирование — ГЛАВНЫЙ БЛОК С ПОЛНЫМ ЛОГИРОВАНИЕМ ===
app.post("/api/scan", (req, res) => {
  const { sessionId, customerCode } = req.body;
  if (!sessionId || !customerCode) {
    log(`ОШИБКА | Нет данных при сканировании (sessionId или customerCode пустые)`);
    return res.json({ success: false, error: "Нет данных" });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    log(`ОШИБКА | Сессия ${sessionId.slice(0,8)}... истекла или не найдена при сканировании`);
    return res.json({ success: false, error: "Сессия истекла" });
  }

  const code = customerCode.toString().trim().replace(/\D/g, "");
  if (code.length < 4) {
    log(`ОШИБКА | Неверный код клиента: ${customerCode}`);
    return res.json({ success: false, error: "Неверный код" });
  }

  // Загружаем выбор продукта
  const sel = session.selection || {};
  const brandName = global.cardConfig?.brands?.[sel.brand]?.name || sel.brand || "Не выбрано";
  const prodName = global.cardConfig?.brands?.[sel.brand]?.products?.[sel.product]?.name || sel.product || "Не выбрано";
  const design = global.cardConfig?.designs?.[sel.designId] || {};
  const designName = design.name || "Не выбрано";
  const designCode = sel.designCode || design.designCode || "???";
  const currency = sel.currency || "Не выбрано";

  log(`СКАНИРОВАНИЕ | Сессия ${sessionId.slice(0,8)}... | Код клиента: ${code} | Выбор: ${brandName} ${prodName} | ${designName} (${designCode}) | ${currency}`);

  db.get("SELECT * FROM clients WHERE client_code = ?", [code], (err, row) => {
    if (err) {
      log(`ОШИБКА БД | Поиск клиента ${code} → ${err.message}`);
      return res.json({ success: false, error: "Ошибка базы" });
    }

    if (!row) {
      log(`КЛИЕНТ НЕ НАЙДЕН В БАЗЕ | Код: ${code} | Сессия ${sessionId.slice(0,8)}...`);
      return res.json({ success: false, error: "Клиент не найден в базе" });
    }

    const fullName = `${row.first_name || ""} ${row.last_name || ""}`.trim() || "Без имени";
    const cardNumber = (row.card_number || "").replace(/\s/g, "").trim();

    log(`НАЙДЕН В БАЗЕ → ${fullName} | Код: ${row.client_code} | Карта: ${cardNumber || "НЕТ НОМЕРА"}`);

    if (!cardNumber) {
      log(`ОТКАЗ | У клиента ${fullName} нет номера карты`);
      return res.json({ success: false, error: "Нет номера карты" });
    }

    // Поиск в embossingFiles
    let originalLine = null;
    try {
      const embossingDir = path.join(__dirname, "public", "embossingFiles");
      if (!fs.existsSync(embossingDir)) {
        log(`ОШИБКА | Папка embossingFiles не найдена: ${embossingDir}`);
        return res.json({ success: false, error: "Папка не найдена" });
      }

      const files = fs.readdirSync(embossingDir);
      for (const file of files) {
        if (!file.toLowerCase().endsWith(".cps2")) continue;
        const content = fs.readFileSync(path.join(embossingDir, file), "utf8");
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          if (line.trim() && (line.includes(cardNumber) || line.replace(/\s/g, "").includes(cardNumber))) {
            originalLine = line;
            break;
          }
        }
        if (originalLine) break;
      }
    } catch (e) {
      log(`ОШИБКА ЧТЕНИЯ embossingFiles → ${e.message}`);
    }

    if (!originalLine) {
      session.notReady = true;
      session.scanned = true;
      session.customerCode = code;

      log(`ЕЩЁ НЕ ГОТОВА | ${fullName} | ${cardNumber} | Карта не найдена в .CPS2 файлах`);
      return res.json({ success: false, notReady: true, error: "Քարտը դեռ պատրաստ չէ" });
    }

    // УСПЕШНАЯ ВЫДАЧА — САМАЯ ВАЖНАЯ СТРОКА В ЛОГЕ
    session.scanned = true;
    session.customerCode = code;

    log(`===================================================================`);
    log(`КАРТА ВЫДАНА УСПЕШНО`);
    log(`Клиент: ${fullName}`);
    const prettyCard = cardNumber ? cardNumber.replace(/(\d{4})/g, '$1 ').trim() : "НЕТ НОМЕРА";
    log(`Код: ${row.client_code} | Карта: ${prettyCard}`);
    log(`Продукт: ${brandName} ${prodName}`);
    log(`Дизайн: ${designName} (${designCode})`);
    log(`Валюта: ${currency}`);
    log(`Сессия: ${sessionId.slice(0,8)}...`);
    log(`Файл: public/printFile/PrintResult.CPS2`);
    log(`===================================================================`);

    fs.writeFile(RESULT_FILE, originalLine + "\n", "utf8", (err) => {
      if (err) {
        log(`ОШИБКА ЗАПИСИ PrintResult.CPS2 → ${err.message}`);
        return res.json({ success: false, error: "Ошибка записи" });
      }
      res.json({ success: true });
    });
  });
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

const httpsOptions = (() => {
  try {
    return {
      key: fs.readFileSync("localhost-key.pem"),
      cert: fs.readFileSync("localhost.pem")
    };
  } catch (e) {
    return null;
  }
})();

if (httpsOptions) {
  require("https").createServer(httpsOptions, app).listen(PORT, "0.0.0.0", () => {
    console.log("\nHTTPS сервер запущен с доверенным сертификатом!");
    console.log(`   https://localhost:${PORT}`);
    console.log(`   Ссылка на результат: https://localhost:${PORT}/PrintResult.CPS2\n`);
  });
} else {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("HTTP режим (сертификаты не найдены)");
  });
}