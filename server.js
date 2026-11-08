'use strict';
/* ============================================================
   Server CRM Đơn Hàng – phục vụ index.html và lưu dữ liệu vào SQLite.
   Chạy: node server.js   (Node >= 22.13, không cần npm install)
   Biến môi trường: PORT (3005), HOST (127.0.0.1), DB_FILE (data/crm.db),
                    APP_AUTH="user:matkhau" để bật đăng nhập Basic Auth.
   Webhook SuperShip: POST /hook/supership/<bí mật> (không cần đăng nhập).
   ============================================================ */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3005;
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'crm.db');
const AUTH = process.env.APP_AUTH || '';
const FB_GRAPH = process.env.FB_GRAPH || 'https://graph.facebook.com';
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
// rev: tăng mỗi khi server tự ghi đơn (webhook / kéo từ SuperShip) để trình duyệt đang mở lấy về
if (!db.prepare('PRAGMA table_info(orders)').all().some(c => c.name === 'rev')) db.exec('ALTER TABLE orders ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');

const q = {
  metaAll: db.prepare('SELECT k, v FROM meta'),
  metaSet: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
  ordersAll: db.prepare('SELECT data FROM orders ORDER BY created_at DESC, rowid DESC'),
  ordersAfter: db.prepare('SELECT data FROM orders WHERE rev > ? ORDER BY rev'),
  maxRev: db.prepare('SELECT COALESCE(MAX(rev), 0) AS rev FROM orders'),
  orderFind: db.prepare('SELECT data FROM orders WHERE ss_code = ? OR (? IS NOT NULL AND soc = ?) LIMIT 1'),
  orderRev: db.prepare('UPDATE orders SET rev = ? WHERE id = ?'),
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
const getMeta = k => { const r = q.metaAll.all().find(x => x.k === k); return r ? JSON.parse(r.v) : null; };
function upsertOrder(o){
  q.orderSet.run(String(o.id), str(o.soc), str(o.ssCode), str(o.status), str(o.receiver && o.receiver.phone), str(o.createdAt), str(o.updatedAt), JSON.stringify(o));
}
// Thay đổi: { meta?, products?, orders?: [..], deleteOrders?: [id], customers?: {phone: obj}, deleteCustomers?: [phone], replace?: true }
function applyChanges(ch){
  db.exec('BEGIN');
  try {
    if (ch.replace) db.exec('DELETE FROM orders; DELETE FROM customers; DELETE FROM meta;');
    if (ch.meta) q.metaSet.run('state', JSON.stringify(ch.meta));
    if (ch.products) q.metaSet.run('products', JSON.stringify(ch.products));
    for (const o of ch.orders || []) if (o && o.id) upsertOrder(o);
    for (const id of ch.deleteOrders || []) q.orderDel.run(String(id));
    for (const [phone, c] of Object.entries(ch.customers || {})) q.custSet.run(phone, JSON.stringify(c));
    for (const phone of ch.deleteCustomers || []) q.custDel.run(String(phone));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Sửa một lần các đơn kéo từ SuperShip trước khi có normalizeSuperShipOrder (payer/config dạng chữ)
function fixPulledOrders(){
  for (const r of db.prepare(`SELECT data FROM orders WHERE data LIKE '%"source":"supership"%'`).all()){
    const o = JSON.parse(r.data); if (normalizeSuperShipOrder(o, null)) upsertOrder(o);
  }
}

// ---------- SuperShip (gọi từ server, dùng token lưu trong Cài đặt) ----------
const STATUS_NAMES = {'0':'Huỷ','1':'Đã Tiếp Nhận','2':'Chờ Lấy Hàng','3':'Đang Lấy Hàng','4':'Đã Lấy Hàng','5':'Hoãn Lấy Hàng','6':'Không Lấy Được','7':'Đang Nhập Kho','8':'Đã Nhập Kho','9':'Đang Chuyển Kho Giao','10':'Đã Chuyển Kho Giao','11':'Đang Giao Hàng','12':'Đã Giao Hàng Toàn Bộ','13':'Đã Giao Hàng Một Phần','14':'Hoãn Giao Hàng','15':'Không Giao Được','16':'Đã Đối Soát Giao Hàng','17':'Đã Đối Soát Trả Hàng','18':'Đang Chuyển Kho Trả','19':'Đã Chuyển Kho Trả','20':'Đang Trả Hàng','21':'Đã Trả Hàng','22':'Hoãn Trả Hàng','23':'Đang Vận Chuyển','24':'Xác Nhận Hoàn','25':'Hàng Thất Lạc','26':'Không Trả Được','27':'Đã Bồi Hoàn'};
const ISSUE_CODES = ['5','6','14','15','22','25','26'];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const num = v => +String(v ?? '').replace(/[^\d.-]/g, '') || 0;

async function ssApi(method, apiPath, { query, body } = {}){
  const st = (getMeta('state') || {}).settings || {};
  if (!st.token) throw new Error('Chưa có token SuperShip trong Cài đặt.');
  let url = String(st.apiBase || 'https://api.mysupership.vn').replace(/\/$/, '') + apiPath;
  if (query) url += '?' + new URLSearchParams(query);
  const res = await fetch(url, { method, headers: Object.assign({ Accept: 'application/json', Authorization: 'Bearer ' + st.token }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  let data = null; try { data = await res.json(); } catch (e) {}
  const ok = data && data.status ? String(data.status).toLowerCase() === 'success' : res.ok;
  if (!res.ok || !ok) throw new Error((data && (data.message || data.error)) || ('SuperShip trả lỗi HTTP ' + res.status));
  return data.results || data;
}
// orders/info trả người trả phí, cách giao dạng chữ ("Người Gửi", "Cho Xem Hàng Nhưng Không Cho Thử") và địa chỉ gộp một chuỗi
const payerCode = v => { const t = String(v ?? '').toLowerCase(); return /^[12]$/.test(t) ? t : /gửi|gui/.test(t) ? '1' : /nhận|nhan/.test(t) ? '2' : null; };
const configCode = v => { const t = String(v ?? '').toLowerCase(); return /^[123]$/.test(t) ? t : /không cho xem|khong cho xem/.test(t) ? '3' : /không cho thử|khong cho thu/.test(t) ? '1' : /thử|thu/.test(t) ? '2' : null; };
function splitAddress(rc){
  const fa = String(rc.formatted_address || '').split(',').map(x => x.trim()).filter(Boolean);
  if (rc.province || fa.length < 4) return null;
  return { address: rc.address || fa.slice(0, -3).join(', '), commune: fa[fa.length - 3], district: fa[fa.length - 2], province: fa[fa.length - 1] };
}
function normalizeSuperShipOrder(o, info){
  let ch = false;
  const pc = payerCode(info ? info.payer : o.payer); if (pc && pc !== o.payer){ o.payer = pc; ch = true; }
  const cc = configCode(info ? info.config : o.config); if (cc && cc !== o.config){ o.config = cc; ch = true; }
  const rc = info && info.receiver && typeof info.receiver === 'object' ? info.receiver : null;
  const sp = rc && !o.receiver.province ? splitAddress(rc) : null;
  if (sp){ Object.assign(o.receiver, sp); ch = true; }
  return ch;
}
const addLog = (o, text) => (o.log = o.log || []).push({ time: new Date().toISOString(), text });
// Ghi thông tin SuperShip (orders/info hoặc payload webhook) vào đơn CRM; tạo đơn mới nếu CRM chưa có.
function applySuperShip(info, how){
  const code = str(info.code); if (!code) throw new Error('Thiếu mã đơn SuperShip');
  const soc = info.soc ? String(info.soc) : null;
  const row = q.orderFind.get(code, soc, soc);
  const now = new Date().toISOString();
  let o = row && JSON.parse(row.data);
  const status = info.status != null ? String(info.status) : null;
  if (!o){
    const rc = info.receiver && typeof info.receiver === 'object' ? info.receiver : {};
    const prods = Array.isArray(info.products) ? info.products : [];
    const items = prods.length ? prods.map(p => ({ sku: str(p.sku) || '', name: str(p.name) || '', qty: num(p.quantity) || 1, price: 0, cost: 0, weight: num(p.weight) }))
      : info.product ? [{ sku: '', name: String(info.product), qty: 1, price: 0, cost: 0, weight: 0 }] : [];
    o = { id: uid(), soc: soc || code, ssCode: code, shortcode: str(info.shortcode) || '', sorting: str(info.sorting) || '',
      createdAt: info.created_at ? new Date(info.created_at).toISOString() : now, updatedAt: now,
      receiver: { name: str(rc.name ?? info.name) || '', phone: str(rc.phone ?? info.phone) || '', address: str(rc.address ?? info.address) || '',
        province: str(rc.province) || '', district: str(rc.district) || '', commune: str(rc.commune) || '' },
      items, subtotal: num(info.value ?? info.amount), amount: num(info.amount), value: num(info.value ?? info.amount), weight: num(info.weight), cost: 0,
      payer: str(info.payer) || '2', config: str(info.config) || '1', note: str(info.note) || '', status: status || '1',
      fee: { shipment: 0, insurance: 0, return: 0 }, journeys: [], ssNotes: [], log: [], issue: { handled: false, note: '' }, source: 'supership' };
    addLog(o, how === 'hook' ? 'Nhận từ SuperShip (webhook), mã ' + code : 'Kéo từ SuperShip, mã ' + code);
  } else if (status && status !== o.status){
    addLog(o, `Trạng thái: ${STATUS_NAMES[o.status] || o.status} → ${STATUS_NAMES[status] || status}`);
    o.status = status; o.updatedAt = now;
    if (ISSUE_CODES.includes(status)) o.issue = { handled: false, note: (o.issue || {}).note || '' };
  }
  o.ssCode = code;
  if (info.shortcode) o.shortcode = String(info.shortcode);
  if (Array.isArray(info.journeys)) o.journeys = info.journeys;
  else if (how === 'hook' && status) (o.journeys = o.journeys || []).push({ time: info.updated_at || now, status: info.status_name || STATUS_NAMES[status] || status, note: info.reason_text || '' });
  if (Array.isArray(info.notes)) o.ssNotes = info.notes;
  if (info.fee && typeof info.fee === 'object') o.fee = { shipment: num(info.fee.shipment), insurance: num(info.fee.insurance), return: num(info.fee.return) };
  else if (info.fshipment != null) o.fee = Object.assign({}, o.fee, { shipment: num(info.fshipment), insurance: num(info.finsurance ?? (o.fee || {}).insurance) });
  if (info.type === 'update_weight' && info.weight != null) o.weight = num(info.weight);
  if (o.source === 'supership') normalizeSuperShipOrder(o, info);
  o.lastSync = now;
  const rev = q.maxRev.get().rev + 1;
  db.exec('BEGIN');
  try { upsertOrder(o); q.orderRev.run(rev, o.id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  return o;
}
async function pullCode(code, hookPayload){
  let info = null;
  try { info = await ssApi('GET', '/v1/partner/orders/info', { query: { code } }); }
  catch (e) { if (!hookPayload) throw e; }
  // Không gọi được orders/info (chưa có token...) thì vẫn ghi theo payload webhook
  return applySuperShip(info ? Object.assign({}, hookPayload || {}, info) : hookPayload, hookPayload ? 'hook' : 'pull');
}
let hookQueue = Promise.resolve();
function hookSecret(){
  let s = getMeta('hookSecret');
  if (!s){ s = require('node:crypto').randomBytes(16).toString('hex'); q.metaSet.run('hookSecret', JSON.stringify(s)); }
  return s;
}
// ---------- Facebook Marketing API: chi phí quảng cáo theo ngày ----------
// Trả về { days: {'YYYY-MM-DD': số tiền}, accounts: [{id, name, currency, spend, error}] }, ngày theo múi giờ tài khoản quảng cáo
async function fbSpend(since, until){
  const st = (getMeta('state') || {}).settings || {};
  if (!st.fbToken) throw new Error('Chưa nhập token Facebook.');
  const ids = String(st.fbAccounts || '').split(/[\s,;]+/).map(x => x.replace(/^act_/, '')).filter(Boolean);
  if (!ids.length) throw new Error('Chưa nhập ID tài khoản quảng cáo.');
  const ver = String(st.fbVersion || 'v25.0').trim();
  const days = {}, accounts = [];
  for (const id of ids){
    const acc = { id, spend: 0 };
    try {
      let next = `${FB_GRAPH}/${ver}/act_${id}/insights?` + new URLSearchParams({
        level: 'account', fields: 'spend,account_name,account_currency', time_increment: '1', limit: '500',
        time_range: JSON.stringify({ since, until }), access_token: st.fbToken });
      while (next){
        const res = await fetch(next, { signal: AbortSignal.timeout(30000) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || d.error) throw new Error((d.error && d.error.message) || 'Facebook trả lỗi HTTP ' + res.status);
        for (const r of d.data || []){
          acc.name = r.account_name; acc.currency = r.account_currency;
          const v = +r.spend || 0; acc.spend += v; days[r.date_start] = (days[r.date_start] || 0) + v;
        }
        next = d.paging && d.paging.next;
      }
    } catch (e) { acc.error = e.message; }
    accounts.push(acc);
  }
  for (const k in days) days[k] = Math.round(days[k]);
  return { days, accounts };
}

const publicBase = req =>(req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host;

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

fixPulledOrders();
http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/hook/supership/' + hookSecret()){
    let payload; try { payload = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    send(res, 200, { ok: true });
    if (payload && payload.code) hookQueue = hookQueue.then(() => pullCode(String(payload.code), payload)).catch(e => console.error('webhook', payload.code, e.message));
    return;
  }
  if (!authorized(req)){ res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="CRM", charset="UTF-8"' }); return res.end('Cần đăng nhập'); }
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, { state: readState(), rev: q.maxRev.get().rev });
    if (url.pathname === '/api/orders' && req.method === 'GET') return send(res, 200, { orders: q.ordersAfter.all(+url.searchParams.get('after') || 0).map(r => JSON.parse(r.data)), rev: q.maxRev.get().rev });
    if (url.pathname === '/api/supership/pull' && req.method === 'POST'){
      const { codes } = await readBody(req); const orders = [], errors = [];
      for (const code of [...new Set((codes || []).map(c => String(c).trim()).filter(Boolean))].slice(0, 500)){
        try { orders.push(await pullCode(code)); } catch (e) { errors.push({ code, error: e.message }); }
      }
      return send(res, 200, { orders, errors, rev: q.maxRev.get().rev });
    }
    if (url.pathname === '/api/supership/webhook'){
      const hookUrl = publicBase(req) + '/hook/supership/' + hookSecret();
      if (req.method === 'POST') await ssApi('POST', '/v1/partner/webhooks/create', { body: { url: hookUrl } });
      let current = null; try { current = await ssApi('GET', '/v1/partner/webhooks'); } catch (e) { current = { error: e.message }; }
      return send(res, 200, { url: hookUrl, current });
    }
    if (url.pathname === '/api/fb/spend' && req.method === 'POST'){
      const { since, until } = await readBody(req); const re = /^\d{4}-\d{2}-\d{2}$/;
      if (!re.test(since) || !re.test(until) || since > until) return send(res, 400, { error: 'Khoảng ngày không hợp lệ' });
      return send(res, 200, await fbSpend(since, until));
    }
    if (url.pathname === '/api/state' && req.method === 'POST'){ applyChanges(await readBody(req)); return send(res, 200, { ok: true }); }
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
    send(res, 404, { error: 'Không tìm thấy' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
}).listen(PORT, HOST, () => console.log(`CRM Đơn Hàng: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (DB: ${DB_FILE})`));
