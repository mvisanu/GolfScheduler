const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data/bookings.db');

(async () => {
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);
  db.run('DELETE FROM bookings WHERE slot_index = 0');
  const deleted = db.getRowsModified();
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  console.log(`Deleted ${deleted} slot_index=0 rows from ${dbPath}`);
})();
