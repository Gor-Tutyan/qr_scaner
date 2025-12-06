const { Client } = require('pg');

const db = {
  user: 'loyalty_user',
  password: '55659596',
  host: '127.0.0.1',
  port: 5434,
  database: 'loyalty'
};

async function найдиКлиента(код) {
  const client = new Client(db);
  await client.connect();

  const res = await client.query('SELECT * FROM get_client_info($1)', [код]);

  await client.end();

  if (res.rows.length === 0) {
    console.log('Клиент не найден');
    return null;
  }

  const клиент = res.rows[0];
  console.log('Карта:', клиент.card_number);
  console.log('Имя:', клиент.first_name);
  console.log('Фамилия:', клиент.last_name);
  return клиент;
}

// Тест
найдиКлиента('361298');
найдиКлиента('107177');