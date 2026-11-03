'use strict';
/* ============================================================
   Server CRM Đơn Hàng – phục vụ index.html và lưu dữ liệu vào SQLite.
   Chạy: node server.js   (Node >= 22.13, không cần npm install)
   Biến môi trường: PORT (3005), HOST (127.0.0.1), DB_FILE (data/crm.db),
                    APP_AUTH="user:matkhau" để bật đăng nhập Basic Auth.
   ============================================================ */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3005;
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'crm.db');
const AUTH = process.env.APP_AUTH || '';
const MAX_BODY = 50 * 1024 * 1024;

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, soc TEXT, ss_code TEXT, status TEXT, phone TEXT,
    created_at TEXT, updated_at TEXT, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS orders_phone ON orders(phone);
  CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
  CREATE TABLE IF NOT EXISTS customers (phone TEXT PRIMARY KEY, data TEXT NOT NULL);
`);

const q = {
  metaAll: db.prepare('SELECT k, v FROM meta'),
  metaSet: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
  ordersAll: db.prepare('SELECT data FROM orders ORDER BY created_at, rowid'),
  orderSet: db.prepare(`INSERT INTO orders (id, soc, ss_code, status, phone, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET soc = excluded.soc, ss_code = excluded.ss_code, status = excluded.status, phone = excluded.phone,
    created_at = excluded.created_at, updated_at = excluded.updated_at, data = excluded.data`),
  orderDel: db.prepare('DELETE FROM orders WHERE id = ?'),
  custAll: db.prepare('SELECT phone, data FROM customers'),
  custSet: db.prepare('INSERT INTO customers (phone, data) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET data = excluded.data'),
  custDel: db.prepare('DELETE FROM customers WHERE phone = ?'),
};
const str = v => v == null ? null : String(v);

function readState(){
  const meta = {}; for (const r of q.metaAll.all()) meta[r.k] = JSON.parse(r.v);
  if (!meta.state) return null;
  const customers = {}; for (const r of q.custAll.all()) customers[r.phone] = JSON.parse(r.data);
  return Object.assign({}, meta.state, { products: meta.products || [], orders: q.ordersAll.all().map(r => JSON.parse(r.data)), customers });
}
// Thay đổi: { meta?, products?, orders?: [..], deleteOrders?: [id], customers?: {phone: obj}, deleteCustomers?: [phone], replace?: true }
function applyChanges(ch){
  db.exec('BEGIN');
  try {
    if (ch.replace) db.exec('DELETE FROM orders; DELETE FROM customers; DELETE FROM meta;');
    if (ch.meta) q.metaSet.run('state', JSON.stringify(ch.meta));
    if (ch.products) q.metaSet.run('products', JSON.stringify(ch.products));
    for (const o of ch.orders || []){
      if (!o || !o.id) continue;
      q.orderSet.run(String(o.id), str(o.soc), str(o.ssCode), str(o.status), str(o.receiver && o.receiver.phone), str(o.createdAt), str(o.updatedAt), JSON.stringify(o));
    }
    for (const id of ch.deleteOrders || []) q.orderDel.run(String(id));
    for (const [phone, c] of Object.entries(ch.customers || {})) q.custSet.run(phone, JSON.stringify(c));
    for (const phone of ch.deleteCustomers || []) q.custDel.run(String(phone));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function send(res, code, body, type = 'application/json; charset=utf-8'){
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req){
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY){ reject(new Error('Dữ liệu quá lớn')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('JSON không hợp lệ')); } });
    req.on('error', reject);
  });
}
function authorized(req){
  if (!AUTH) return true;
  const h = req.headers.authorization || '';
  return h.startsWith('Basic ') && Buffer.from(h.slice(6), 'base64').toString('utf8') === AUTH;
}

http.createServer(async (req, res) => {
  if (!authorized(req)){ res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="CRM", charset="UTF-8"' }); return res.end('Cần đăng nhập'); }
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, { state: readState() });
    if (url.pathname === '/api/state' && req.method === 'POST'){ applyChanges(await readBody(req)); return send(res, 200, { ok: true }); }
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
    send(res, 404, { error: 'Không tìm thấy' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
}).listen(PORT, HOST, () => console.log(`CRM Đơn Hàng: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (DB: ${DB_FILE})`));
