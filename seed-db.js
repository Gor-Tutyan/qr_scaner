// seed-db.js
// Этот файл запускается один раз — заполняет базу тестовыми клиентами

const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

// Определяем путь к базе (так же, как в server.js)
const isProduction = process.env.RENDER || process.env.NODE_ENV === "production";
const dbDir = isProduction ? "/tmp" : path.join(__dirname, "db");
const dbPath = path.join(dbDir, "database.sqlite");

// Создаём папку локально, если её нет
if (!isProduction) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

console.log("Подключаемся к базе:", dbPath);

db.serialize(() => {
  // Создаём таблицу, если её нет
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    client_code TEXT PRIMARY KEY,
    card_number TEXT,
    first_name TEXT,
    last_name TEXT
  )`);

  // Проверяем, есть ли уже данные
  db.get("SELECT COUNT(*) AS count FROM clients", (err, row) => {
    if (err) {
      console.error("Ошибка:", err);
      db.close();
      return;
    }

    if (row.count > 0) {
      console.log(`В базе уже есть ${row.count} клиентов — ничего не добавляем`);
      db.close();
      return;
    }

    console.log("База пустая — добавляем 8 крутых тестовых клиентов...");

    const clients = [
      ["12345", "4374690101156220", "Иван", "Иванов"],
      ["54321", "5555 6666 7777 8888", "Мария", "Петрова"],
      ["777",   "4000 1234 5678 9010", "Алексей", "Сидоров"],
      ["99999", "3714 496353 98431",   "Ольга", "Кузнецова"],
      ["111",   "6011 0009 9013 9424", "Дмитрий", "Волков"],
      ["888",   "3056 9300 0904 0000", "Екатерина", "Смирнова"],
      ["2222",  "5105 1051 0510 5100", "Сергей", "Козлов"],
      ["55555", "2223 0000 4848 4848", "Анастасия", "Лебедева"]
    ];

    const stmt = db.prepare(
      `INSERT OR REPLACE INTO clients (client_code, card_number, first_name, last_name) 
       VALUES (?, ?, ?, ?)`
    );

    clients.forEach(c => stmt.run(c));

    stmt.finalize(() => {
      console.log("Успешно добавлено 8 тестовых клиентов!");
      console.log("Коды для теста: 12345, 54321, 777, 99999, 111, 888, 2222, 55555");
      db.close(() => {
        console.log("Готово! Можешь запускать сервер.");
        process.exit(0);
      });
    });
  });
});