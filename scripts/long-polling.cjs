/**
 * VK Bot — единый монолитный файл
 * Группа 1: чаты сотрудников + ЛС руководства/сотрудников
 * Группа 2: ЛС клиентов доставки
 * Группа 3: ЛС клиентов такси
 *
 * Три параллельных Long Poll цикла в одном процессе.
 * База данных: better-sqlite3 (bot.db)
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ─── .env ────────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });

// ─── КОНФИГ ──────────────────────────────────────────────────────────────────
const G1_TOKEN  = process.env.VK_GROUP1_TOKEN  || '';
const G2_TOKEN  = process.env.VK_GROUP2_TOKEN  || '';
const G3_TOKEN  = process.env.VK_GROUP3_TOKEN  || '';
const G1_ID     = process.env.VK_GROUP1_ID     || '';
const G2_ID     = process.env.VK_GROUP2_ID     || '';
const G3_ID     = process.env.VK_GROUP3_ID     || '';
const API_VER   = '5.131';

// ID чатов (peer_id = 2000000000 + chat_id)
const CHATS = {
  rukovodstvo:    parseInt(process.env.VK_CHAT_RUKOVODSTVO_ID    || '0'),
  ss:             parseInt(process.env.VK_CHAT_SS_ID             || '0'),
  uchebny:        parseInt(process.env.VK_CHAT_UCHEBNY_ID        || '0'),
  doska:          parseInt(process.env.VK_CHAT_DOSKA_ID          || '0'),
  dispetcherskaya:parseInt(process.env.VK_CHAT_DISPETCHERSKAYA_ID|| '0'),
  fludilka:       parseInt(process.env.VK_CHAT_FLUDILKA_ID       || '0'),
  zhurnal:        parseInt(process.env.VK_CHAT_ZHURNAL_ID        || '0'),
  sponsor:        parseInt(process.env.VK_CHAT_SPONSOR_ID        || '0'),
  // Такси-отдельные чаты (если нужны) берутся из тех же переменных
  dispetcherskaya_taxi: parseInt(process.env.VK_CHAT_DISP_TAXI_ID|| '0'),
  ss_taxi:        parseInt(process.env.VK_CHAT_SS_TAXI_ID        || '0'),
  fludilka_taxi:  parseInt(process.env.VK_CHAT_FLUDILKA_TAXI_ID  || '0'),
};

// ─── SQLite ───────────────────────────────────────────────────────────────────
let Database;
try { Database = require('better-sqlite3'); }
catch(e) { console.error('[DB] Установите: npm install better-sqlite3'); process.exit(1); }

const db = new Database(path.join(__dirname, 'bot.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS staff (
    vk_id        INTEGER PRIMARY KEY,
    nick         TEXT NOT NULL,
    bank_acc     TEXT,
    role         TEXT DEFAULT 'kurier',
    org_delivery INTEGER DEFAULT 0,
    org_taxi     INTEGER DEFAULT 0,
    orders_done  INTEGER DEFAULT 0,
    orders_week  INTEGER DEFAULT 0,
    registered_at INTEGER DEFAULT (strftime('%s','now')*1000)
  );

  CREATE TABLE IF NOT EXISTS org_vehicles (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    photo_url TEXT,
    added_by  INTEGER,
    added_at  INTEGER DEFAULT (strftime('%s','now')*1000)
  );

  CREATE TABLE IF NOT EXISTS vehicles (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    vk_id          INTEGER NOT NULL,
    name           TEXT NOT NULL,
    photo_url      TEXT,
    is_org         INTEGER DEFAULT 0,
    is_colored     INTEGER DEFAULT 0,
    org_vehicle_id INTEGER,
    FOREIGN KEY(vk_id) REFERENCES staff(vk_id)
  );

  CREATE TABLE IF NOT EXISTS categories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    parent_id INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id      INTEGER NOT NULL,
    name             TEXT NOT NULL,
    price            INTEGER NOT NULL,
    cost             INTEGER NOT NULL,
    photo_url        TEXT,
    instruction_photo TEXT,
    simple_items     TEXT DEFAULT '[]',
    FOREIGN KEY(category_id) REFERENCES categories(id)
  );

  CREATE TABLE IF NOT EXISTS sets (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    price     INTEGER NOT NULL,
    cost      INTEGER NOT NULL,
    photo_url TEXT
  );

  CREATE TABLE IF NOT EXISTS set_items (
    set_id     INTEGER NOT NULL,
    product_id INTEGER,
    name       TEXT,
    qty        INTEGER DEFAULT 1,
    FOREIGN KEY(set_id) REFERENCES sets(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    client_vk_id    INTEGER NOT NULL,
    client_nick     TEXT NOT NULL,
    location        TEXT NOT NULL,
    status          TEXT DEFAULT 'pending',
    courier_vk_id   INTEGER DEFAULT NULL,
    courier_nick    TEXT DEFAULT NULL,
    eta_minutes     INTEGER DEFAULT NULL,
    payment_type    TEXT DEFAULT 'cash',
    payment_proof   TEXT DEFAULT NULL,
    promo_code      TEXT DEFAULT NULL,
    discount_amt    INTEGER DEFAULT 0,
    total_price     INTEGER NOT NULL,
    total_cost      INTEGER NOT NULL,
    dispatch_msg_id INTEGER DEFAULT NULL,
    cart_msg_id     INTEGER DEFAULT NULL,
    helper_msg_id   INTEGER DEFAULT NULL,
    created_at      INTEGER DEFAULT (strftime('%s','now')*1000),
    updated_at      INTEGER DEFAULT (strftime('%s','now')*1000)
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL,
    product_id INTEGER,
    set_id     INTEGER,
    name       TEXT NOT NULL,
    price      INTEGER NOT NULL,
    cost       INTEGER NOT NULL,
    qty        INTEGER DEFAULT 1,
    bought     INTEGER DEFAULT 0,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  );

  CREATE TABLE IF NOT EXISTS taxi_orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    client_vk_id    INTEGER NOT NULL,
    client_nick     TEXT NOT NULL,
    passengers      TEXT DEFAULT '[]',
    from_point_id   INTEGER NOT NULL,
    to_point_id     INTEGER NOT NULL,
    from_name       TEXT NOT NULL,
    to_name         TEXT NOT NULL,
    distance_km     REAL DEFAULT 0,
    payment_type    TEXT DEFAULT 'cash',
    payment_proof   TEXT DEFAULT NULL,
    promo_code      TEXT DEFAULT NULL,
    discount_amt    INTEGER DEFAULT 0,
    total_price     INTEGER NOT NULL,
    status          TEXT DEFAULT 'pending',
    driver_vk_id    INTEGER DEFAULT NULL,
    driver_nick     TEXT DEFAULT NULL,
    paid_waiting    INTEGER DEFAULT 0,
    dispatch_msg_id INTEGER DEFAULT NULL,
    cart_msg_id     INTEGER DEFAULT NULL,
    created_at      INTEGER DEFAULT (strftime('%s','now')*1000),
    updated_at      INTEGER DEFAULT (strftime('%s','now')*1000)
  );

  CREATE TABLE IF NOT EXISTS promos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    org         TEXT NOT NULL,
    type        TEXT NOT NULL,
    value       INTEGER DEFAULT 0,
    product_id  INTEGER DEFAULT NULL,
    category_id INTEGER DEFAULT NULL,
    uses_left   INTEGER DEFAULT -1,
    expires_at  INTEGER DEFAULT NULL,
    created_by  INTEGER,
    created_at  INTEGER DEFAULT (strftime('%s','now')*1000)
  );

  CREATE TABLE IF NOT EXISTS online_sessions (
    vk_id        INTEGER PRIMARY KEY,
    nick         TEXT NOT NULL,
    role         TEXT DEFAULT '',
    status       TEXT DEFAULT 'online',
    status_text  TEXT DEFAULT '',
    org_delivery INTEGER DEFAULT 0,
    org_taxi     INTEGER DEFAULT 0,
    started_at   INTEGER DEFAULT (strftime('%s','now')*1000),
    last_msg_id  INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vk_id       INTEGER NOT NULL,
    nick        TEXT NOT NULL,
    role        TEXT DEFAULT '',
    action      TEXT NOT NULL,
    status_text TEXT DEFAULT '',
    logged_at   INTEGER DEFAULT (strftime('%s','now')*1000)
  );

  CREATE TABLE IF NOT EXISTS online_stats (
    vk_id     INTEGER NOT NULL,
    date_str  TEXT NOT NULL,
    seconds   INTEGER DEFAULT 0,
    PRIMARY KEY(vk_id, date_str)
  );

  CREATE TABLE IF NOT EXISTS daily_stats (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    date_str      TEXT NOT NULL,
    org           TEXT NOT NULL,
    orders_count  INTEGER DEFAULT 0,
    total_revenue INTEGER DEFAULT 0,
    total_cost    INTEGER DEFAULT 0,
    reported      INTEGER DEFAULT 0,
    UNIQUE(date_str, org)
  );

  CREATE TABLE IF NOT EXISTS blacklist (
    vk_id     INTEGER PRIMARY KEY,
    end_date  INTEGER DEFAULT 0,
    reason    TEXT DEFAULT 'Нарушение правил',
    banned_at INTEGER DEFAULT (strftime('%s','now')*1000),
    banned_by INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS mutes (
    vk_id     INTEGER PRIMARY KEY,
    end_date  INTEGER NOT NULL,
    reason    TEXT DEFAULT 'Нарушение правил',
    muted_at  INTEGER DEFAULT (strftime('%s','now')*1000),
    muted_by  INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
  );

  CREATE TABLE IF NOT EXISTS map_cities (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS map_categories (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS map_points (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    city_id     INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    lat         REAL NOT NULL,
    lng         REAL NOT NULL,
    FOREIGN KEY(city_id)     REFERENCES map_cities(id),
    FOREIGN KEY(category_id) REFERENCES map_categories(id)
  );

  INSERT OR IGNORE INTO categories(id, name) VALUES(1, 'Сеты');

  INSERT OR IGNORE INTO settings(key,value) VALUES('taxi_rate_per_km','50');
  INSERT OR IGNORE INTO settings(key,value) VALUES('taxi_peak_multiplier','1.5');
  INSERT OR IGNORE INTO settings(key,value) VALUES('taxi_peak_hours','[[8,10],[17,20]]');
  INSERT OR IGNORE INTO settings(key,value) VALUES('bank_account','852006');
  INSERT OR IGNORE INTO settings(key,value) VALUES('bank_commission_pct','5');
  INSERT OR IGNORE INTO settings(key,value) VALUES('phone_commission_pct','7');
  INSERT OR IGNORE INTO settings(key,value) VALUES('taxi_waiting_rate_per_min','10');
  INSERT OR IGNORE INTO settings(key,value) VALUES('salary_pct','15');
  INSERT OR IGNORE INTO settings(key,value) VALUES('salary_colored_pct','10');
  INSERT OR IGNORE INTO settings(key,value) VALUES('income_org_pct','5');
`);
console.log('[DB] Инициализирована:', path.join(__dirname, 'bot.db'));

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
const q = (sql) => db.prepare(sql);

function getSetting(key)       { const r = q('SELECT value FROM settings WHERE key=?').get(key); return r ? r.value : null; }
function setSetting(key, val)  { q('INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)').run(key, String(val), Date.now()); }

// Blacklist
function blAdd(vkId, days, reason, by) {
  const end = (!days || days === 0 || days >= 999) ? 0 : Date.now() + days * 86400000;
  q('INSERT OR REPLACE INTO blacklist(vk_id,end_date,reason,banned_at,banned_by) VALUES(?,?,?,?,?)').run(vkId, end, reason||'Нарушение', Date.now(), by||null);
}
function blRemove(vkId) { return q('DELETE FROM blacklist WHERE vk_id=?').run(vkId).changes > 0; }
function blGet(vkId) {
  const r = q('SELECT * FROM blacklist WHERE vk_id=?').get(vkId);
  if (!r) return null;
  if (r.end_date !== 0 && r.end_date < Date.now()) { blRemove(vkId); return null; }
  return r;
}
function blAll() { return q('SELECT * FROM blacklist WHERE end_date=0 OR end_date>?').all(Date.now()); }

// Mutes
function muteAdd(vkId, minutes, reason, by) {
  q('INSERT OR REPLACE INTO mutes(vk_id,end_date,reason,muted_at,muted_by) VALUES(?,?,?,?,?)').run(vkId, Date.now()+minutes*60000, reason||'Нарушение', Date.now(), by||null);
}
function muteRemove(vkId) { return q('DELETE FROM mutes WHERE vk_id=?').run(vkId).changes > 0; }
function muteGet(vkId) {
  const r = q('SELECT * FROM mutes WHERE vk_id=?').get(vkId);
  if (!r) return null;
  if (r.end_date < Date.now()) { muteRemove(vkId); return null; }
  return r;
}

// Staff
function staffGet(vkId)           { return q('SELECT * FROM staff WHERE vk_id=?').get(vkId); }
function staffGetAll()             { return q('SELECT * FROM staff').all(); }
function staffCreate(vkId, nick, bankAcc) { q('INSERT OR IGNORE INTO staff(vk_id,nick,bank_acc) VALUES(?,?,?)').run(vkId, nick, bankAcc||null); }
function staffUpdate(vkId, fields) {
  const keys = Object.keys(fields); if (!keys.length) return;
  q(`UPDATE staff SET ${keys.map(k=>k+'=?').join(',')} WHERE vk_id=?`).run(...keys.map(k=>fields[k]), vkId);
}

// Vehicles
function vehicleAdd(vkId, name, photoUrl, isOrg, isColored, orgVehicleId) {
  return q('INSERT INTO vehicles(vk_id,name,photo_url,is_org,is_colored,org_vehicle_id) VALUES(?,?,?,?,?,?)').run(vkId, name, photoUrl||null, isOrg?1:0, isColored?1:0, orgVehicleId||null).lastInsertRowid;
}
function vehicleGetAll(vkId)  { return q('SELECT * FROM vehicles WHERE vk_id=?').all(vkId); }
function vehicleRemove(id)    { q('DELETE FROM vehicles WHERE id=?').run(id); }
function orgVehicleAdd(name, photoUrl, by) { return q('INSERT INTO org_vehicles(name,photo_url,added_by) VALUES(?,?,?)').run(name, photoUrl||null, by||null).lastInsertRowid; }
function orgVehicleAll()      { return q('SELECT * FROM org_vehicles').all(); }
function orgVehicleGet(id)    { return q('SELECT * FROM org_vehicles WHERE id=?').get(id); }

// Categories
function catAll()             { return q('SELECT * FROM categories').all(); }
function catGet(id)           { return q('SELECT * FROM categories WHERE id=?').get(id); }
function catAdd(name, parentId) { return q('INSERT INTO categories(name,parent_id) VALUES(?,?)').run(name, parentId||null).lastInsertRowid; }
function catRemove(id)        { q('DELETE FROM categories WHERE id=?').run(id); }

// Products
function prodAll(catId)       { return catId !== undefined ? q('SELECT * FROM products WHERE category_id=?').all(catId) : q('SELECT * FROM products').all(); }
function prodGet(id)          { return q('SELECT * FROM products WHERE id=?').get(id); }
function prodAdd(catId, name, price, cost, photoUrl, instrPhoto, simpleItems) {
  return q('INSERT INTO products(category_id,name,price,cost,photo_url,instruction_photo,simple_items) VALUES(?,?,?,?,?,?,?)').run(catId, name, price, cost, photoUrl||null, instrPhoto||null, JSON.stringify(simpleItems||[])).lastInsertRowid;
}
function prodRemove(id)       { q('DELETE FROM products WHERE id=?').run(id); }

// Sets
function setAll()             { return q('SELECT * FROM sets').all(); }
function setGet(id)           { return q('SELECT * FROM sets WHERE id=?').get(id); }
function setAdd(name, price, cost, photoUrl) { return q('INSERT INTO sets(name,price,cost,photo_url) VALUES(?,?,?,?)').run(name, price, cost, photoUrl||null).lastInsertRowid; }
function setItemsGet(setId)   { return q('SELECT * FROM set_items WHERE set_id=?').all(setId); }
function setItemAdd(setId, productId, name, qty) { q('INSERT INTO set_items(set_id,product_id,name,qty) VALUES(?,?,?,?)').run(setId, productId||null, name||null, qty||1); }
function setRemove(id)        { q('DELETE FROM set_items WHERE set_id=?').run(id); q('DELETE FROM sets WHERE id=?').run(id); }

// Orders
function orderCreate(data) {
  return q(`INSERT INTO orders(client_vk_id,client_nick,location,payment_type,total_price,total_cost,promo_code,discount_amt)
    VALUES(?,?,?,?,?,?,?,?)`).run(data.client_vk_id, data.client_nick, data.location, data.payment_type||'cash', data.total_price, data.total_cost, data.promo_code||null, data.discount_amt||0).lastInsertRowid;
}
function orderGet(id)         { return q('SELECT * FROM orders WHERE id=?').get(id); }
function orderUpdate(id, fields) {
  const keys = Object.keys(fields); if (!keys.length) return;
  q(`UPDATE orders SET ${keys.map(k=>k+'=?').join(',')},updated_at=? WHERE id=?`).run(...keys.map(k=>fields[k]), Date.now(), id);
}
function orderItemsGet(orderId) { return q('SELECT * FROM order_items WHERE order_id=?').all(orderId); }
function orderItemAdd(orderId, name, price, cost, qty, productId, setId) {
  q('INSERT INTO order_items(order_id,name,price,cost,qty,product_id,set_id) VALUES(?,?,?,?,?,?,?)').run(orderId, name, price, cost, qty||1, productId||null, setId||null);
}
function orderItemUpdate(id, fields) {
  const keys = Object.keys(fields); if (!keys.length) return;
  q(`UPDATE order_items SET ${keys.map(k=>k+'=?').join(',')} WHERE id=?`).run(...keys.map(k=>fields[k]), id);
}
function ordersByClient(vkId, status) {
  if (status) return q('SELECT * FROM orders WHERE client_vk_id=? AND status=? ORDER BY created_at DESC').all(vkId, status);
  return q('SELECT * FROM orders WHERE client_vk_id=? ORDER BY created_at DESC').all(vkId);
}
function ordersByCourier(vkId) { return q("SELECT * FROM orders WHERE courier_vk_id=? AND status NOT IN ('done','cancelled') ORDER BY created_at DESC").all(vkId); }

// Taxi orders
function taxiCreate(data) {
  return q(`INSERT INTO taxi_orders(client_vk_id,client_nick,passengers,from_point_id,to_point_id,from_name,to_name,distance_km,payment_type,total_price,promo_code,discount_amt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(data.client_vk_id, data.client_nick, JSON.stringify(data.passengers||[]), data.from_point_id, data.to_point_id, data.from_name, data.to_name, data.distance_km||0, data.payment_type||'cash', data.total_price, data.promo_code||null, data.discount_amt||0).lastInsertRowid;
}
function taxiGet(id)          { return q('SELECT * FROM taxi_orders WHERE id=?').get(id); }
function taxiUpdate(id, fields) {
  const keys = Object.keys(fields); if (!keys.length) return;
  q(`UPDATE taxi_orders SET ${keys.map(k=>k+'=?').join(',')},updated_at=? WHERE id=?`).run(...keys.map(k=>fields[k]), Date.now(), id);
}
function taxiByClient(vkId)   { return q('SELECT * FROM taxi_orders WHERE client_vk_id=? ORDER BY created_at DESC').all(vkId); }

// Promos
function promoGet(code, org) {
  const r = q('SELECT * FROM promos WHERE code=? AND org=?').get(code, org);
  if (!r) return null;
  if (r.expires_at && r.expires_at < Date.now()) return null;
  if (r.uses_left === 0) return null;
  return r;
}
function promoUse(id) {
  const r = q('SELECT uses_left FROM promos WHERE id=?').get(id);
  if (r && r.uses_left > 0) q('UPDATE promos SET uses_left=uses_left-1 WHERE id=?').run(id);
}
function promoAdd(data) {
  q('INSERT OR IGNORE INTO promos(code,org,type,value,product_id,category_id,uses_left,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)').run(data.code, data.org, data.type, data.value||0, data.product_id||null, data.category_id||null, data.uses_left??-1, data.expires_at||null, data.created_by||null);
}
function promoAll(org)        { return q('SELECT * FROM promos WHERE org=?').all(org); }

// Map
function mapPointGet(id)      { return q('SELECT * FROM map_points WHERE id=?').get(id); }
function mapPointAll()        { return q('SELECT mp.*, mc.name city_name, mcat.name cat_name FROM map_points mp JOIN map_cities mc ON mp.city_id=mc.id JOIN map_categories mcat ON mp.category_id=mcat.id').all(); }
function mapCityAll()         { return q('SELECT * FROM map_cities').all(); }
function mapCatAll()          { return q('SELECT * FROM map_categories').all(); }
function mapPointsByCityAndCat(cityId, catId) { return q('SELECT * FROM map_points WHERE city_id=? AND category_id=?').all(cityId, catId); }

// Online Sessions
function onlineSet(vkId, nick, role, status, statusText, orgDelivery, orgTaxi) {
  q('INSERT OR REPLACE INTO online_sessions(vk_id,nick,role,status,status_text,org_delivery,org_taxi,started_at) VALUES(?,?,?,?,?,?,?,?)').run(vkId, nick, role||'', status||'online', statusText||'', orgDelivery?1:0, orgTaxi?1:0, Date.now());
}
function onlineRemove(vkId)   { q('DELETE FROM online_sessions WHERE vk_id=?').run(vkId); }
function onlineGetAll()       { return q('SELECT * FROM online_sessions ORDER BY started_at').all(); }
function onlineGet(vkId)      { return q('SELECT * FROM online_sessions WHERE vk_id=?').get(vkId); }
function onlineUpdateStatus(vkId, status, statusText) { q('UPDATE online_sessions SET status=?,status_text=? WHERE vk_id=?').run(status, statusText||'', vkId); }

// Daily stats
function statsIncOrder(org, revenue, cost) {
  const d = dateMSK().split(' ')[0]; // YYYY-MM-DD
  q('INSERT INTO daily_stats(date_str,org,orders_count,total_revenue,total_cost) VALUES(?,?,1,?,?) ON CONFLICT(date_str,org) DO UPDATE SET orders_count=orders_count+1,total_revenue=total_revenue+excluded.total_revenue,total_cost=total_cost+excluded.total_cost').run(d, org, revenue, cost);
}
function statsGetToday(org)   { const d = dateMSK().split(' ')[0]; return q('SELECT * FROM daily_stats WHERE date_str=? AND org=?').get(d, org); }
function statsGetRange(from, to, org) { return q('SELECT * FROM daily_stats WHERE date_str>=? AND date_str<=? AND org=?').all(from, to, org||'delivery'); }
function statsMarkReported(dateStr, org) { q('UPDATE daily_stats SET reported=1 WHERE date_str=? AND org=?').run(dateStr, org); }

// ─── УТИЛИТЫ ─────────────────────────────────────────────────────────────────
function dateMSK(ts) {
  const d = new Date(ts || Date.now());
  const m = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const pad = n => String(n).padStart(2,'0');
  return `${m.getFullYear()}-${pad(m.getMonth()+1)}-${pad(m.getDate())} ${pad(m.getHours())}:${pad(m.getMinutes())}`;
}
function fmtDate(ts) {
  const d = new Date(ts || Date.now());
  const m = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const pad = n => String(n).padStart(2,'0');
  return `${pad(m.getDate())}.${pad(m.getMonth()+1)}.${m.getFullYear()} ${pad(m.getHours())}:${pad(m.getMinutes())}`;
}
function fmtBanDate(end) {
  if (!end || end === 0) return 'ПЕРМАНЕНТНО';
  return fmtDate(end);
}
function peerToChatId(peerId) { return peerId - 2000000000; }
function extractUserId(link) {
  for (const p of [/vk\.com\/id(\d+)/, /\[id(\d+)\|/, /^id(\d+)$/, /^(\d+)$/]) {
    const m = String(link||'').match(p); if (m) return parseInt(m[1]);
  }
  return null;
}
function userLink(u) { return u ? `[id${u.id}|${u.first_name} ${u.last_name}]` : ''; }
function rand() { return Math.floor(Math.random() * 1e9); }

// Haversine distance (km)
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2-lat1), dLng = toRad(lng2-lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Рассчитать стоимость такси
function calcTaxiPrice(distKm) {
  const rate = parseFloat(getSetting('taxi_rate_per_km') || '50');
  const mult = parseFloat(getSetting('taxi_peak_multiplier') || '1.5');
  const peakHours = JSON.parse(getSetting('taxi_peak_hours') || '[[8,10],[17,20]]');
  const h = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).getHours();
  const isPeak = peakHours.some(([s, e]) => h >= s && h < e);
  return Math.round(distKm * rate * (isPeak ? mult : 1));
}

// Роль по номеру ярлыка (rs/ss/kurier/stazher)
const ROLE_LABEL = { rs: 'РС', ss: 'СС', kurier: 'Курьер', stazher: 'Стажёр' };

function getChatName(peerId) {
  const n = {
    [CHATS.rukovodstvo]: 'Руководство', [CHATS.ss]: 'Старший Состав',
    [CHATS.uchebny]: 'Учебный', [CHATS.doska]: 'Доска Объявлений',
    [CHATS.dispetcherskaya]: 'Диспетчерская', [CHATS.fludilka]: 'Флудилка',
    [CHATS.zhurnal]: 'Журнал Активности', [CHATS.sponsor]: 'Спонсорская беседа',
  };
  return n[peerId] || `Чат ${peerToChatId(peerId)}`;
}

function parseDuration(text) {
  text = String(text||'').toLowerCase().trim();
  const m = text.match(/(\d+)\s*(мин|минут|минуты|м\b)/); if (m) return parseInt(m[1]);
  const h = text.match(/(\d+)\s*(час|часа|часов|ч\b)/);   if (h) return parseInt(h[1])*60;
  const d = text.match(/(\d+)\s*(день|дня|дней|д\b)/);    if (d) return parseInt(d[1])*1440;
  return null;
}

function roleDisplayShort(role) { return ROLE_LABEL[role] || role || '?'; }

// ─── VK API ──────────────────────────────────────────────────────────────────
async function callVK(method, params={}, token=G1_TOKEN) {
  const body = new URLSearchParams({ ...params, access_token: token, v: API_VER });
  const res  = await fetch(`https://api.vk.com/method/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (data.error) throw new Error(`VK ${method}: ${data.error.error_msg}`);
  return data.response;
}

// Обёртки для трёх групп
function api1(method, params={}) { return callVK(method, params, G1_TOKEN); }
function api2(method, params={}) { return callVK(method, params, G2_TOKEN); }
function api3(method, params={}) { return callVK(method, params, G3_TOKEN); }

async function send1(peerId, text, extra={}) {
  try { return await api1('messages.send', { peer_id:peerId, message:text, random_id:rand(), ...extra }); }
  catch(e) { console.error('[G1 send]', e.message); return null; }
}
async function send2(peerId, text, extra={}) {
  try { return await api2('messages.send', { peer_id:peerId, message:text, random_id:rand(), ...extra }); }
  catch(e) { console.error('[G2 send]', e.message); return null; }
}
async function send3(peerId, text, extra={}) {
  try { return await api3('messages.send', { peer_id:peerId, message:text, random_id:rand(), ...extra }); }
  catch(e) { console.error('[G3 send]', e.message); return null; }
}
async function edit1(peerId, cmid, text, extra={}) {
  try { return await api1('messages.edit', { peer_id:peerId, conversation_message_id:cmid, message:text, ...extra }); }
  catch(e) { console.error('[G1 edit]', e.message); }
}
async function edit2(peerId, cmid, text, extra={}) {
  try { return await api2('messages.edit', { peer_id:peerId, conversation_message_id:cmid, message:text, ...extra }); }
  catch(e) { console.error('[G2 edit]', e.message); }
}
async function edit3(peerId, cmid, text, extra={}) {
  try { return await api3('messages.edit', { peer_id:peerId, conversation_message_id:cmid, message:text, ...extra }); }
  catch(e) { console.error('[G3 edit]', e.message); }
}

async function getUser(userId, token=G1_TOKEN) {
  try { const r = await callVK('users.get', { user_ids: userId }, token); return r[0]; }
  catch(e) { return null; }
}

async function getChatMembers(peerId, token=G1_TOKEN) {
  try { return await callVK('messages.getConversationMembers', { peer_id: peerId }, token); }
  catch(e) { return { items: [] }; }
}

async function getLongPollServer(groupId, token) {
  return await callVK('groups.getLongPollServer', { group_id: groupId }, token);
}

// Кнопки (keyboard builder)
function kb(buttons, inline=false) {
  return JSON.stringify({ inline, buttons });
}
function btn(label, payload, color='secondary') {
  return [{ action: { type: 'callback', label, payload: JSON.stringify(payload) }, color }];
}
function btnText(label, payload) {
  return [{ action: { type: 'text', label, payload: JSON.stringify(payload) } }];
}

// ─── ПРАВА ───────────────────────────────────────────────────────────────────
// Определяем роль по чатам (кэшируем дорогой getUserRole через staffGet)
function getRoleByChat(peerId) {
  if (peerId === CHATS.rukovodstvo) return 'rs';
  if (peerId === CHATS.ss)         return 'ss';
  if ([CHATS.fludilka, CHATS.dispetcherskaya, CHATS.zhurnal, CHATS.doska].includes(peerId)) return 'kurier';
  if (peerId === CHATS.uchebny)    return 'stazher';
  return null;
}

async function getUserRole(userId) {
  // Сначала из БД (быстро)
  const s = staffGet(userId);
  if (s) return s.role;
  // Иначе по чатам
  for (const [name, pid] of Object.entries(CHATS)) {
    if (!pid) continue;
    try {
      const m = await getChatMembers(pid);
      if (m.items.some(i => i.member_id === userId)) {
        if (pid === CHATS.rukovodstvo) return 'rs';
        if (pid === CHATS.ss)         return 'ss';
      }
    } catch {}
  }
  return null;
}

async function hasPermission(userId, peerId, roles) {
  const r = await getUserRole(userId);
  if (r && roles.includes(r)) return true;
  const cr = getRoleByChat(peerId);
  if (cr && roles.includes(cr)) return true;
  return false;
}

// ─── ПРОМОКОД: применить к сумме доставки ────────────────────────────────────
function applyPromo(promo, cartItems, total) {
  if (!promo) return { discount: 0, freeItem: null };
  switch (promo.type) {
    case 'discount_pct':
      return { discount: Math.round(total * promo.value / 100), freeItem: null };
    case 'discount_abs':
      return { discount: Math.min(promo.value, total), freeItem: null };
    case 'free_product': {
      const p = prodGet(promo.product_id);
      return { discount: p ? p.price : 0, freeItem: p || null };
    }
    case 'free_category': {
      // клиент выбирает товар — скидка пока 0, обрабатывается при выборе
      return { discount: 0, freeItem: null, needChoose: true };
    }
    case 'discount_product_pct': {
      const item = cartItems.find(i => i.product_id === promo.product_id);
      if (!item) return { discount: 0, freeItem: null };
      return { discount: Math.round(item.price * item.qty * promo.value / 100), freeItem: null };
    }
    case 'discount_product_abs': {
      const item = cartItems.find(i => i.product_id === promo.product_id);
      if (!item) return { discount: 0, freeItem: null };
      return { discount: Math.min(promo.value * item.qty, item.price * item.qty), freeItem: null };
    }
    default: return { discount: 0, freeItem: null };
  }
}

function applyTaxiPromo(promo, total) {
  if (!promo) return 0;
  switch (promo.type) {
    case 'discount_pct': return Math.round(total * promo.value / 100);
    case 'discount_abs': return Math.min(promo.value, total);
    case 'free_ride':    return total;
    default:             return 0;
  }
}

// ─── СЕССИИ КЛИЕНТОВ (in-memory state machine) ───────────────────────────────
// Формат: clientSessions.get(vkId) = { step, data, msgId }
const clientSessionsG2 = new Map(); // клиенты доставки
const clientSessionsG3 = new Map(); // клиенты такси

// ─── КОРЗИНА: форматирование ──────────────────────────────────────────────────
function formatCart(items, discount, promoCode) {
  if (!items.length) return 'Корзина пуста';
  let lines = ['____________'];
  for (const it of items) {
    lines.push(`${it.name} | ${it.price}р. (х${it.qty})`);
  }
  lines.push('______________');
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  lines.push(`Итог: ${total - (discount||0)}р.${discount ? ` (скидка ${discount}р.)` : ''}${promoCode ? ` [${promoCode}]` : ''}`);
  return lines.join('\n');
}

// ─── ПОМОЩНИК КУРЬЕРА: форматирование ────────────────────────────────────────
function formatCourierHelper(items) {
  // Собираем простые товары из всех позиций
  const toBuy = [];
  for (const item of items) {
    if (item.bought) continue;
    // Пытаемся получить simple_items из продукта
    if (item.product_id) {
      const p = prodGet(item.product_id);
      if (p && p.simple_items) {
        const si = JSON.parse(p.simple_items || '[]');
        if (si.length) {
          toBuy.push(`${item.name}: ${si.map(s => `${s.name} х${s.qty}`).join(', ')}`);
        } else {
          toBuy.push(`${item.name} х${item.qty}`);
        }
      } else {
        toBuy.push(`${item.name} х${item.qty}`);
      }
    } else {
      toBuy.push(`${item.name} х${item.qty}`);
    }
  }
  if (!toBuy.length) return 'Все позиции куплены!';
  return 'Купить:\n' + toBuy.join('\n');
}

// ─── ЖУРНАЛ АКТИВНОСТИ ────────────────────────────────────────────────────────
function buildOnlineList(sessions) {
  if (!sessions.length) return 'На сервере никого нет.';
  const lines = ['На сервере:'];
  for (const s of sessions) {
    const roleLabel = roleDisplayShort(s.role);
    lines.push(`${s.nick} (${roleLabel}) ${s.status_text || s.status}`);
  }
  return lines.join('\n');
}

// ─── УВЕДОМЛЕНИЯ КУРЬЕРОВ ────────────────────────────────────────────────────
async function notifyCouriers(peerId, userIds, token=G1_TOKEN) {
  const chunks = [];
  for (let i = 0; i < userIds.length; i += 10) chunks.push(userIds.slice(i, i+10));
  for (const ch of chunks) {
    const mention = ch.map(id => `[id${id}|.]`).join(' ');
    try {
      const cmid = await callVK('messages.send', { peer_id:peerId, message:mention, random_id:rand() }, token);
      if (cmid) {
        await callVK('messages.delete', { peer_id:peerId, delete_for_all:1, cmids:String(cmid) }, token);
      }
    } catch {}
  }
}

// Получить список курьеров/водителей в онлайн для нужной орг
function getOnlineCouriers(org) {
  return onlineGetAll().filter(s => {
    if (s.status === 'offline') return false;
    const member = staffGet(s.vk_id);
    if (!member) return false;
    if (org === 'delivery') return member.org_delivery === 1;
    if (org === 'taxi')     return member.org_taxi === 1;
    return false;
  });
}

// ─── СЕССИИ РЕГИСТРАЦИИ СОТРУДНИКОВ (ЛС Группы 1) ──────────────────────────
const staffRegSessions = new Map(); // vkId -> { step, data }

// ─── СЕССИИ ДОБАВЛЕНИЯ ТОВАРОВ (ЛС Группы 1) ────────────────────────────────
const addItemSessions = new Map(); // vkId -> { step, type, data }

// ─── СЕССИИ ДОБАВЛЕНИЯ ПРОМОКОДОВ (ЛС Группы 1/3) ───────────────────────────
const promoAddSessions = new Map(); // vkId -> { step, data, org }

// ─── ХРАНИЛИЩА OLD-STYLE (совместимость) ────────────────────────────────────
const greetings = new Map();   // peerId -> { text, attachments }
const pinnedMsgs = new Map();  // peerId -> cmid

// Загрузка старых JSON (однократно, при старте)
(function migrateJson() {
  const blFile = path.join(__dirname, 'blacklist.json');
  if (fs.existsSync(blFile)) {
    try {
      const d = JSON.parse(fs.readFileSync(blFile, 'utf8'));
      for (const [id, info] of Object.entries(d)) {
        const exists = q('SELECT vk_id FROM blacklist WHERE vk_id=?').get(parseInt(id));
        if (!exists) blAdd(parseInt(id), 0, info.reason, info.bannedBy);
      }
      console.log('[DB] blacklist.json мигрирован');
    } catch {}
  }
  const muFile = path.join(__dirname, 'mutes.json');
  if (fs.existsSync(muFile)) {
    try {
      const d = JSON.parse(fs.readFileSync(muFile, 'utf8'));
      for (const [id, info] of Object.entries(d)) {
        if (info.endDate > Date.now()) {
          const exists = q('SELECT vk_id FROM mutes WHERE vk_id=?').get(parseInt(id));
          if (!exists) q('INSERT OR IGNORE INTO mutes(vk_id,end_date,reason) VALUES(?,?,?)').run(parseInt(id), info.endDate, info.reason||'');
        }
      }
      console.log('[DB] mutes.json мигрирован');
    } catch {}
  }
})();

// ═══════════════════════════════════════════════════════════════════════════════
//  ГРУППА 1: ОБРАБОТЧИК СООБЩЕНИЙ В ЧАТАХ И ЛС СОТРУДНИКОВ
// ═══════════════════════════════════════════════════════════════════════════════

async function reuploadPhoto(photoAtt, groupId, useG2=false) {
  try {
    const sizes = (photoAtt.sizes||[]).sort((a,b) => (b.width*b.height)-(a.width*a.height));
    if (!sizes.length) return null;
    const buf = await (await fetch(sizes[0].url)).arrayBuffer();
    const upServer = await (useG2 ? api2 : api1)('photos.getWallUploadServer', { group_id: groupId });
    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('photo', Buffer.from(buf), { filename:'photo.jpg', contentType:'image/jpeg' });
    const upRes = await (await fetch(upServer.upload_url, { method:'POST', body:fd, headers:fd.getHeaders() })).json();
    const saved = await (useG2 ? api2 : api1)('photos.saveWallPhoto', { group_id:groupId, photo:upRes.photo, server:upRes.server, hash:upRes.hash });
    if (saved?.[0]) { const p=saved[0]; return `photo${p.owner_id}_${p.id}`; }
    return null;
  } catch(e) { console.error('[reuploadPhoto]', e.message); return null; }
}

// ─── КОМАНДЫ ЧАТОВ (Группа 1) ────────────────────────────────────────────────
async function cmdPost(ctx) {
  if (!await hasPermission(ctx.userId, ctx.peerId, ['rs','ss'])) {
    return send1(ctx.peerId, 'Команда доступна только РС и СС');
  }
  if (!ctx.replyMsg) return send1(ctx.peerId, 'Ответьте на сообщение для публикации');
  try {
    const msg = ctx.replyMsg;
    const atts = [];
    for (const a of (msg.attachments||[])) {
      if (a.type==='photo') { const id = await reuploadPhoto(a.photo, G2_ID, true); if (id) atts.push(id); }
      else if (a.type==='video'&&a.video) atts.push(`video${a.video.owner_id}_${a.video.id}${a.video.access_key?'_'+a.video.access_key:''}`);
    }
    await api2('wall.post', { owner_id:-G2_ID, message:msg.text||'', from_group:1, ...(atts.length?{attachments:atts.join(',')}:{}) });
    send1(ctx.peerId, 'Пост опубликован в группе 2');
  } catch(e) { send1(ctx.peerId, 'Ошибка: '+e.message); }
}

async function cmdPrikaz(ctx) {
  if (!await hasPermission(ctx.userId, ctx.peerId, ['rs','ss'])) {
    return send1(ctx.peerId, 'Команда доступна только РС и СС');
  }
  if (!ctx.replyMsg) return send1(ctx.peerId, 'Ответьте на сообщение для публикации');
  try {
    const msg = ctx.replyMsg;
    const atts = [];
    for (const a of (msg.attachments||[])) {
      if (a.type==='photo') { const id = await reuploadPhoto(a.photo, G1_ID); if (id) atts.push(id); }
    }
    await api1('wall.post', { owner_id:-G1_ID, message:msg.text||'', from_group:1, ...(atts.length?{attachments:atts.join(',')}:{}) });
    send1(ctx.peerId, 'Приказ опубликован');
  } catch(e) { send1(ctx.peerId, 'Ошибка: '+e.message); }
}

function getChatIdByAlias(a) {
  const map = { рс:CHATS.rukovodstvo, сс:CHATS.ss, уц:CHATS.uchebny, до:CHATS.doska, дисп:CHATS.dispetcherskaya, диспетчерская:CHATS.dispetcherskaya, флуд:CHATS.fludilka, жа:CHATS.zhurnal, журнал:CHATS.zhurnal, спонсор:CHATS.sponsor };
  return map[(a||'').toLowerCase()];
}

async function cmdGreeting(ctx) {
  if (!await hasPermission(ctx.userId, ctx.peerId, ['rs'])) return send1(ctx.peerId, 'Только РС');
  if (!ctx.replyMsg) return send1(ctx.peerId, 'Ответьте на сообщение с текстом приветствия');
  let targetPeer = ctx.peerId;
  if (ctx.args[1]) { const p = getChatIdByAlias(ctx.args[1]); if (p) targetPeer = p; }
  const atts = [];
  for (const a of (ctx.replyMsg.attachments||[])) {
    if (a.type==='photo') atts.push(`photo${a.photo.owner_id}_${a.photo.id}${a.photo.access_key?'_'+a.photo.access_key:''}`);
  }
  greetings.set(targetPeer, { text: ctx.replyMsg.text||'', attachments: atts });
  send1(ctx.peerId, `Приветствие установлено для ${getChatName(targetPeer)}`);
}

async function cmdPin(ctx) {
  if (!await hasPermission(ctx.userId, ctx.peerId, ['rs'])) return send1(ctx.peerId, 'Только РС');
  if (!ctx.replyMsg) return send1(ctx.peerId, 'Ответьте на сообщение');
  let targetPeer = ctx.peerId;
  if (ctx.args[1]) { const p = getChatIdByAlias(ctx.args[1]); if (p) targetPeer = p; }
  const cmid = pinnedMsgs.get(targetPeer);
  if (!cmid) return send1(ctx.peerId, 'Нет закреплённого сообщения. Сначала закрепите вручную в VK.');
  const msg = ctx.replyMsg;
  const atts = [];
  for (const a of (msg.attachments||[])) {
    if (a.type==='photo') atts.push(`photo${a.photo.owner_id}_${a.photo.id}${a.photo.access_key?'_'+a.photo.access_key:''}`);
  }
  try {
    await edit1(targetPeer, cmid, msg.text||'', atts.length ? { attachment:atts.join(',') } : {});
    send1(ctx.peerId, `Закреп обновлён в ${getChatName(targetPeer)}`);
  } catch(e) { send1(ctx.peerId, 'Ошибка: '+e.message); }
}

async function cmdKick(ctx) {
  if (!await hasPermission(ctx.userId, ctx.peerId, ['rs','ss'])) return send1(ctx.peerId, 'Только РС и СС');
  if (!ctx.args[1]) return send1(ctx.peerId, 'Использование: !кик [ссылка] [дни|perm]');
  const targetId = extractUserId(ctx.args[1]);
  if (!targetId) return send1(ctx.peerId, 'Не удалось определить ID');
  const tu = await getUser(targetId);
  const tLink = tu ? userLink(tu) : `[id${targetId}|ID${targetId}]`;
  const isSponsor = ctx.args[2] === 'спонсор';
  if (isSponsor) {
    try { await api1('messages.removeChatUser', { chat_id:peerToChatId(CHATS.sponsor), member_id:targetId }); send1(ctx.peerId, `${tLink} удалён из Спонсорской беседы`); }
    catch(e) { send1(ctx.peerId, 'Ошибка: '+e.message); }
    return;
  }
  const banArg = (ctx.args[2]||'').toLowerCase();
  let banDays = banArg === 'perm' || banArg === 'перманент' ? 0 : (parseInt(ctx.args[2])||0);
  const chats = Object.values(CHATS).filter(id => id > 0 && id !== CHATS.sponsor);
  let removed = 0;
  for (const pid of chats) {
    try { await api1('messages.removeChatUser', { chat_id:peerToChatId(pid), member_id:targetId }); removed++; }
    catch {}
  }
  if (banDays >= 0 && ctx.args[2]) {
    const ini = await getUser(ctx.userId); const iniName = ini ? `${ini.first_name} ${ini.last_name}` : `ID${ctx.userId}`;
    blAdd(targetId, banDays, `Кик (${iniName})`, ctx.userId);
  }
  send1(ctx.peerId, `${tLink} кикнут из ${removed} чатов${banDays >= 0 && ctx.args[2] ? `, в ЧС до ${fmtBanDate(banDays===0?0:Date.now()+banDays*86400000)}` : ''}`);
}

async function cmdChatInfo(ctx) {
  send1(ctx.peerId, `Чат: ${getChatName(ctx.peerId)}\nPeer ID: ${ctx.peerId}\nChat ID: ${peerToChatId(ctx.peerId)}`);
}

async function cmdNotify(ctx) {
  if (ctx.peerId === CHATS.rukovodstvo) return;
  const role = await getUserRole(ctx.userId);
  if (!['rs','ss'].includes(role)) return;
  try {
    const members = await getChatMembers(ctx.peerId);
    const ids = members.items.filter(m => m.member_id > 0).map(m => m.member_id);
    await notifyCouriers(ctx.peerId, ids);
    send1(ctx.peerId, `Уведомлено ${ids.length} участников`);
  } catch(e) { send1(ctx.peerId, 'Ошибка: '+e.message); }
}

async function cmdDiagnostics(ctx) {
  if (!await hasPermission(ctx.userId, ctx.peerId, ['rs'])) return;
  let r = 'Диагностика чатов:\n';
  for (const [name, pid] of Object.entries(CHATS)) {
    if (!pid) { r += `- ${name}: не настроен\n`; continue; }
    try {
      const info = await api1('messages.getConversationsById', { peer_ids: pid });
      r += `- ${name}: OK (peer_id=${pid})\n`;
    } catch(e) { r += `- ${name}: ОШИБКА ${e.message}\n`; }
  }
  send1(ctx.peerId, r);
}

async function cmdBlacklist(ctx) {
  if (!await hasPermission(ctx.userId, ctx.peerId, ['rs','ss'])) return send1(ctx.peerId, 'Только РС и СС');
  const sub = (ctx.args[1]||'').toLowerCase();
  if (sub === 'список' || !sub) {
    const all = blAll();
    if (!all.length) return send1(ctx.peerId, 'ЧС пуст');
    const lines = all.map(b => `[id${b.vk_id}|ID${b.vk_id}] до ${fmtBanDate(b.end_date)} — ${b.reason}`);
    return send1(ctx.peerId, 'ЧС:\n'+lines.join('\n'));
  }
  if (sub === 'разбан') {
    const id = extractUserId(ctx.args[2]);
    if (!id) return send1(ctx.peerId, 'Укажите пользователя');
    blRemove(id) ? send1(ctx.peerId, `ID${id} разбанен`) : send1(ctx.peerId, `ID${id} не в ЧС`);
    return;
  }
  if (sub === 'проверка') {
    const id = extractUserId(ctx.args[2]);
    if (!id) return send1(ctx.peerId, 'Укажите пользователя');
    const b = blGet(id);
    return send1(ctx.peerId, b ? `ID${id} в ЧС до ${fmtBanDate(b.end_date)}\nПричина: ${b.reason}` : `ID${id} не в ЧС`);
  }
  send1(ctx.peerId, '!чс список / разбан / проверка');
}

async function cmdMute(ctx) {
  if (!await hasPermission(ctx.userId, ctx.peerId, ['rs','ss'])) return send1(ctx.peerId, 'Только РС и СС');
  let targetId = ctx.replyMsg?.from_id || extractUserId(ctx.args[1]);
  if (!targetId) return send1(ctx.peerId, 'Укажите пользователя');
  const duraArg = ctx.replyMsg ? ctx.args.slice(1,3).join(' ') : ctx.args.slice(2,4).join(' ');
  const dur = parseDuration(duraArg);
  if (!dur) return send1(ctx.peerId, 'Некорректное время (например: 1 час, 30 минут)');
  muteAdd(targetId, dur, 'Нарушение', ctx.userId);
  const tu = await getUser(targetId);
  const tLink = tu ? userLink(tu) : `[id${targetId}|ID${targetId}]`;
  send1(ctx.peerId, `${tLink} замучен на ${dur} мин.`);
}

async function cmdUnmute(ctx) {
  if (!await hasPermission(ctx.userId, ctx.peerId, ['rs','ss'])) return send1(ctx.peerId, 'Только РС и СС');
  const targetId = ctx.replyMsg?.from_id || extractUserId(ctx.args[1]);
  if (!targetId) return send1(ctx.peerId, 'Укажите пользователя');
  muteRemove(targetId) ? send1(ctx.peerId, `Мут снят с ID${targetId}`) : send1(ctx.peerId, `ID${targetId} не замучен`);
}

// !стата — статистика онлайна
async function cmdStata(ctx) {
  const sessions = onlineGetAll();
  const total = sessions.length;
  const delivery = sessions.filter(s => s.org_delivery).length;
  const taxi     = sessions.filter(s => s.org_taxi).length;
  let txt = `Онлайн сейчас: ${total}\n  Доставка: ${delivery}\n  Такси: ${taxi}\n\n${buildOnlineList(sessions)}`;
  send1(ctx.peerId, txt);
}

// !профиль [ссылка] — просмотр профиля сотрудника
async function cmdProfile(ctx) {
  let targetId = ctx.args[1] ? extractUserId(ctx.args[1]) : ctx.userId;
  const s = staffGet(targetId);
  if (!s) return send1(ctx.peerId, `У ID${targetId} нет профиля сотрудника`);
  const vehicles = vehicleGetAll(targetId);
  const vList = vehicles.map(v => `${v.name}${v.is_colored?' (в цветах орг.)':''}${v.is_org?' (орг.)':' (личное)'}`).join(', ') || 'нет';
  const orgs = [s.org_delivery?'Доставка':null, s.org_taxi?'Такси':null].filter(Boolean).join(', ')||'нет';
  send1(ctx.peerId, `Профиль [id${s.vk_id}|${s.nick}]\nРоль: ${roleDisplayShort(s.role)}\nОрганизации: ${orgs}\nБанк. счёт: ${s.bank_acc||'не указан'}\nЗаказов выполнено: ${s.orders_done}\nАвтопарк: ${vList}`);
}

// Журнал Активности: обработка команд в чате
async function handleActivityLog(message) {
  const text = (message.text||'').trim().toLowerCase();
  const peerId = message.peer_id;
  if (peerId !== CHATS.zhurnal) return false;

  const from = message.from_id;
  const staff = staffGet(from);
  if (!staff) return false; // только зарегистрированные

  const match = text.match(/^!(онлайн|афк|вышел)(?:\s+(.+))?$/);
  if (!match) {
    // !стата в ЖА
    if (text === '!стата') { await cmdStata({ peerId, userId: from, args: ['!стата'], replyMsg: null }); return true; }
    return false;
  }

  const cmd = match[1], statusText = match[2]||'';
  const now = onlineGet(from);

  if (cmd === 'онлайн') {
    const defStatus = staff.role === 'stazher' ? 'экзамен' : 'доставка';
    const finalStatus = statusText || defStatus;
    onlineSet(from, staff.nick, staff.role, 'online', finalStatus, staff.org_delivery, staff.org_taxi);
    q('INSERT INTO activity_log(vk_id,nick,role,action,status_text) VALUES(?,?,?,?,?)').run(from, staff.nick, staff.role, 'online', finalStatus);
    // Обновляем сообщение в ЖА
    const sessions = onlineGetAll();
    const newTxt = `${staff.nick} в сети. (${finalStatus})\n${buildOnlineList(sessions)}`;
    await send1(peerId, newTxt);
    return true;
  }
  if (cmd === 'афк') {
    if (!now) return true;
    const defStatus = 'Не у ПК';
    onlineUpdateStatus(from, 'afk', statusText || defStatus);
    q('INSERT INTO activity_log(vk_id,nick,role,action,status_text) VALUES(?,?,?,?,?)').run(from, staff.nick, staff.role, 'afk', statusText||defStatus);
    const sessions = onlineGetAll();
    const newTxt = `${staff.nick} ушёл в АФК. (${statusText||defStatus})\n${buildOnlineList(sessions)}`;
    await send1(peerId, newTxt);
    return true;
  }
  if (cmd === 'вышел') {
    if (now) {
      // Засчитываем онлайн в статистику
      const secs = Math.floor((Date.now() - now.started_at) / 1000);
      const ds = dateMSK().split(' ')[0];
      q('INSERT INTO online_stats(vk_id,date_str,seconds) VALUES(?,?,?) ON CONFLICT(vk_id,date_str) DO UPDATE SET seconds=seconds+excluded.seconds').run(from, ds, secs);
      onlineRemove(from);
    }
    q('INSERT INTO activity_log(vk_id,nick,role,action,status_text) VALUES(?,?,?,?,?)').run(from, staff.nick, staff.role, 'offline', '');
    const sessions = onlineGetAll();
    const newTxt = `${staff.nick} вышел.\n${buildOnlineList(sessions)}`;
    await send1(peerId, newTxt);
    return true;
  }
  return false;
}

// ─── ЛС СОТРУДНИКОВ (Группа 1) ───────────────────────────────────────────────
async function handleG1DM(message) {
  const from = message.from_id;
  const text = (message.text||'').trim();
  const atts  = message.attachments || [];

  // Сессия регистрации
  if (staffRegSessions.has(from)) {
    await handleStaffReg(from, text, atts, message);
    return;
  }
  // Сессия добавления товара/сета/категории
  if (addItemSessions.has(from)) {
    await handleAddItem(from, text, atts, message);
    return;
  }
  // Сессия добавления промокода
  if (promoAddSessions.has(from)) {
    await handlePromoAdd(from, text, atts, 'delivery');
    return;
  }

  const staff = staffGet(from);

  // Главное меню ЛС
  if (!text || text === 'Главное меню' || text.toLowerCase() === '/start') {
    return sendG1MainMenu(from, staff);
  }
  if (text === 'Мой профиль') { return cmdProfile({ peerId: from, userId: from, args: ['!профиль'], replyMsg: null }); }
  if (text === 'Мой автопарк') { return sendVehicleMenu(from, staff); }
  if (text === 'Моя статистика') { return sendMyStats(from, staff); }

  // RS/SS: добавление товаров, промокодов, авто орг.
  if (staff && ['rs','ss'].includes(staff.role)) {
    if (text === 'Добавить товар')        { return startAddItem(from, 'product'); }
    if (text === 'Добавить сет')          { return startAddItem(from, 'set'); }
    if (text === 'Добавить категорию')    { return startAddItem(from, 'category'); }
    if (text === 'Добавить авто орг.')    { return startAddOrgVehicle(from); }
    if (text === 'Добавить промокод')     { return startPromoAdd(from, 'delivery', staff); }
    if (text === 'Промокоды доставки')    { return sendPromoList(from, 'delivery'); }
    if (text === 'Промокоды такси')       { return sendPromoList(from, 'taxi'); }
    if (text === 'Список товаров')        { return sendProductList(from); }
    if (text === 'Добавить промокод такси') { return startPromoAdd(from, 'taxi', staff); }
    if (text === 'Профили сотрудников')   { return sendStaffList(from); }
    if (text === 'Статистика онлайна')    { return sendOnlineStats(from); }
  }

  // Если нет профиля — начать регистрацию
  if (!staff) {
    if (text.toLowerCase().includes('регистрация') || text.toLowerCase() === 'зарегистрироваться') {
      return startStaffReg(from);
    }
    return send1(from, 'Добро пожаловать! Для работы необходимо зарегистрироваться.\n\nНапишите "Зарегистрироваться" или нажмите кнопку.',
      { keyboard: kb([[{ action:{ type:'text', label:'Зарегистрироваться', payload:JSON.stringify({cmd:'reg'}) }}]], false) }
    );
  }

  // Начать регистрацию
  if (text.toLowerCase() === 'зарегистрироваться' || text.toLowerCase() === 'регистрация') {
    return startStaffReg(from);
  }
}

async function sendG1MainMenu(vkId, staff) {
  if (!staff) {
    return send1(vkId, 'Вы не зарегистрированы. Для работы необходимо создать профиль сотрудника.',
      { keyboard: kb([[{ action:{ type:'text', label:'Зарегистрироваться' } }]], false) }
    );
  }
  const isAdmin = ['rs','ss'].includes(staff.role);
  const rows = [
    [{ action:{ type:'text', label:'Мой профиль' } }, { action:{ type:'text', label:'Мой автопарк' } }],
    [{ action:{ type:'text', label:'Моя статистика' } }],
  ];
  if (isAdmin) {
    rows.push([{ action:{ type:'text', label:'Добавить товар' } }, { action:{ type:'text', label:'Добавить сет' } }]);
    rows.push([{ action:{ type:'text', label:'Добавить категорию' } }, { action:{ type:'text', label:'Список товаров' } }]);
    rows.push([{ action:{ type:'text', label:'Добавить авто орг.' } }, { action:{ type:'text', label:'Профили сотрудников' } }]);
    rows.push([{ action:{ type:'text', label:'Добавить промокод' } }, { action:{ type:'text', label:'Добавить промокод такси' } }]);
    rows.push([{ action:{ type:'text', label:'Промокоды доставки' } }, { action:{ type:'text', label:'Промокоды такси' } }]);
    rows.push([{ action:{ type:'text', label:'Статистика онлайна' } }]);
  }
  send1(vkId, `Главное меню сотрудника\nРоль: ${roleDisplayShort(staff.role)} | Ник: ${staff.nick}`, { keyboard: kb(rows, false) });
}

// --- Регистрация сотрудника ---
async function startStaffReg(vkId) {
  staffRegSessions.set(vkId, { step: 'nick', data: {} });
  send1(vkId, 'Регистрация сотрудника.\n\nШаг 1/3: Введите ваш игровой никнейм (VK ник персонажа):');
}

async function handleStaffReg(vkId, text, atts, message) {
  const sess = staffRegSessions.get(vkId);
  if (!sess) return;

  if (sess.step === 'nick') {
    sess.data.nick = text.trim();
    sess.step = 'bank';
    staffRegSessions.set(vkId, sess);
    return send1(vkId, 'Шаг 2/3: Введите ваш банковский счёт (номер):');
  }
  if (sess.step === 'bank') {
    sess.data.bankAcc = text.trim();
    sess.step = 'confirm';
    staffRegSessions.set(vkId, sess);
    return send1(vkId, `Шаг 3/3: Подтвердите данные:\nНик: ${sess.data.nick}\nБанк. счёт: ${sess.data.bankAcc}`,
      { keyboard: kb([[{ action:{ type:'text', label:'Подтвердить' }}, { action:{ type:'text', label:'Отмена' }}]], false) }
    );
  }
  if (sess.step === 'confirm') {
    if (text === 'Подтвердить') {
      staffCreate(vkId, sess.data.nick, sess.data.bankAcc);
      staffRegSessions.delete(vkId);
      return send1(vkId, `Профиль создан! Ник: ${sess.data.nick}\n\nТеперь добавьте автомобиль в автопарк (без авто нельзя брать заказы).`, {
        keyboard: kb([[{ action:{ type:'text', label:'Добавить авто' } }, { action:{ type:'text', label:'Главное меню' } }]], false)
      });
    }
    staffRegSessions.delete(vkId);
    return send1(vkId, 'Регистрация отменена.');
  }
}

// --- Автопарк ---
async function sendVehicleMenu(vkId, staff) {
  if (!staff) return send1(vkId, 'Сначала зарегистрируйтесь');
  const veh = vehicleGetAll(vkId);
  const orgVeh = orgVehicleAll();
  let txt = 'Ваш автопарк:\n';
  if (!veh.length) txt += '(пусто)\n';
  else veh.forEach((v,i) => { txt += `${i+1}. ${v.name}${v.is_org?' [Орг.]':''}${v.is_colored?' [В цветах]':''}\n`; });
  const rows = [[{ action:{ type:'text', label:'Добавить личное авто' } }]];
  if (orgVeh.length) rows.push([{ action:{ type:'text', label:'Взять авто организации' } }]);
  rows.push([{ action:{ type:'text', label:'Главное меню' } }]);
  send1(vkId, txt, { keyboard: kb(rows, false) });
}

async function sendMyStats(vkId, staff) {
  if (!staff) return;
  const stats7 = (() => {
    const rows = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i*86400000);
      const ds = dateMSK(d).split(' ')[0];
      const r = q('SELECT * FROM online_stats WHERE vk_id=? AND date_str=?').get(vkId, ds);
      if (r) rows.push({ date: ds, secs: r.seconds });
    }
    return rows;
  })();
  const totalSecs = stats7.reduce((s,r) => s+r.secs, 0);
  const hrs = Math.floor(totalSecs/3600), mins = Math.floor((totalSecs%3600)/60);
  send1(vkId, `Ваша статистика:\nЗаказов выполнено: ${staff.orders_done}\nЗа неделю: ${staff.orders_week}\nОнлайн за 7 дней: ${hrs}ч. ${mins}мин.`);
}

// --- Добавление товара/сета/категории ---
async function startAddItem(vkId, type) {
  addItemSessions.set(vkId, { step: 'name', type, data: {} });
  const labels = { product: 'Введите название товара:', set: 'Введите название сета:', category: 'Введите название категории:' };
  send1(vkId, labels[type] || 'Введите название:');
}

async function handleAddItem(vkId, text, atts, message) {
  const sess = addItemSessions.get(vkId);
  if (!sess) return;

  const done = () => addItemSessions.delete(vkId);

  if (text === 'Отмена') { done(); return send1(vkId, 'Отменено.'); }

  // --- КАТЕГОРИЯ ---
  if (sess.type === 'category') {
    if (sess.step === 'name') {
      const id = catAdd(text.trim());
      done();
      return send1(vkId, `Категория "${text.trim()}" добавлена (ID ${id})`);
    }
    return;
  }

  // --- СЕТ ---
  if (sess.type === 'set') {
    if (sess.step === 'name') {
      sess.data.name = text.trim(); sess.step = 'price';
      addItemSessions.set(vkId, sess);
      return send1(vkId, 'Введите цену сета (руб.):');
    }
    if (sess.step === 'price') {
      sess.data.price = parseInt(text)||0; sess.step = 'cost';
      addItemSessions.set(vkId, sess);
      return send1(vkId, 'Введите себестоимость сета (руб.):');
    }
    if (sess.step === 'cost') {
      sess.data.cost = parseInt(text)||0; sess.step = 'items';
      sess.data.items = []; sess.data.pendingItem = null;
      addItemSessions.set(vkId, sess);
      return send1(vkId, 'Добавьте товары в сет. Формат: "Название | Количество"\nКогда закончите — напишите "Готово"',
        { keyboard: kb([[{ action:{ type:'text', label:'Готово' } }]], false) }
      );
    }
    if (sess.step === 'items') {
      if (text === 'Готово') {
        const id = setAdd(sess.data.name, sess.data.price, sess.data.cost, null);
        for (const it of (sess.data.items||[])) setItemAdd(id, null, it.name, it.qty);
        done();
        return send1(vkId, `Сет "${sess.data.name}" добавлен (ID ${id}) с ${sess.data.items.length} позициями.`);
      }
      const parts = text.split('|').map(s => s.trim());
      const name = parts[0], qty = parseInt(parts[1])||1;
      sess.data.items.push({ name, qty });
      addItemSessions.set(vkId, sess);
      return send1(vkId, `Добавлено: ${name} x${qty}. Добавьте ещё или нажмите "Готово".`);
    }
    return;
  }

  // --- ТОВАР ---
  if (sess.type === 'product') {
    if (sess.step === 'name') {
      sess.data.name = text.trim(); sess.step = 'price';
      addItemSessions.set(vkId, sess);
      return send1(vkId, 'Введите цену для клиентов (руб.):');
    }
    if (sess.step === 'price') {
      sess.data.price = parseInt(text)||0; sess.step = 'cost';
      addItemSessions.set(vkId, sess);
      return send1(vkId, 'Введите себестоимость (руб.):');
    }
    if (sess.step === 'cost') {
      sess.data.cost = parseInt(text)||0; sess.step = 'category';
      addItemSessions.set(vkId, sess);
      const cats = catAll();
      const rows = cats.map(c => [{ action:{ type:'text', label:`${c.id}. ${c.name}` } }]);
      rows.push([{ action:{ type:'text', label:'Новая категория' } }]);
      return send1(vkId, 'Выберите категорию:', { keyboard: kb(rows, false) });
    }
    if (sess.step === 'category') {
      if (text === 'Новая категория') {
        sess.step = 'new_category'; addItemSessions.set(vkId, sess);
        return send1(vkId, 'Введите название новой категории:');
      }
      const m = text.match(/^(\d+)\./);
      if (m) { sess.data.categoryId = parseInt(m[1]); }
      else { const cat = catAll().find(c => c.name === text); if (cat) sess.data.categoryId = cat.id; }
      if (!sess.data.categoryId) return send1(vkId, 'Категория не найдена. Попробуйте снова.');
      sess.step = 'simple_items'; addItemSessions.set(vkId, sess);
      return send1(vkId, 'Добавьте простые составляющие товара (например "Томат | 1"). Напишите "Нет" если это простой товар.',
        { keyboard: kb([[{ action:{ type:'text', label:'Нет' } }]], false) }
      );
    }
    if (sess.step === 'new_category') {
      sess.data.categoryId = catAdd(text.trim());
      sess.step = 'simple_items'; addItemSessions.set(vkId, sess);
      return send1(vkId, `Категория "${text.trim()}" создана. Теперь добавьте простые составляющие или напишите "Нет".`);
    }
    if (sess.step === 'simple_items') {
      if (!sess.data.simpleItems) sess.data.simpleItems = [];
      if (text === 'Нет' || text === 'Готово') {
        sess.step = 'instruction'; addItemSessions.set(vkId, sess);
        return send1(vkId, 'Пришлите фото-инструкцию для курьера (или напишите "Нет"):',
          { keyboard: kb([[{ action:{ type:'text', label:'Нет' } }]], false) }
        );
      }
      const parts = text.split('|').map(s => s.trim());
      sess.data.simpleItems.push({ name: parts[0], qty: parseInt(parts[1])||1 });
      addItemSessions.set(vkId, sess);
      return send1(vkId, `Добавлено: ${parts[0]} x${parseInt(parts[1])||1}. Ещё или "Готово":`,
        { keyboard: kb([[{ action:{ type:'text', label:'Готово' } }]], false) }
      );
    }
    if (sess.step === 'instruction') {
      let instrPhoto = null;
      if (atts.length && atts[0].type === 'photo') {
        const ph = atts[0].photo;
        instrPhoto = `photo${ph.owner_id}_${ph.id}${ph.access_key?'_'+ph.access_key:''}`;
      }
      if (text === 'Нет') instrPhoto = null;
      sess.step = 'photo'; sess.data.instrPhoto = instrPhoto;
      addItemSessions.set(vkId, sess);
      return send1(vkId, 'Пришлите фото товара для клиентов (или "Нет"):',
        { keyboard: kb([[{ action:{ type:'text', label:'Нет' } }]], false) }
      );
    }
    if (sess.step === 'photo') {
      let photoUrl = null;
      if (atts.length && atts[0].type === 'photo') {
        const ph = atts[0].photo;
        photoUrl = `photo${ph.owner_id}_${ph.id}${ph.access_key?'_'+ph.access_key:''}`;
      }
      const id = prodAdd(sess.data.categoryId, sess.data.name, sess.data.price, sess.data.cost, photoUrl, sess.data.instrPhoto, sess.data.simpleItems||[]);
      done();
      return send1(vkId, `Товар "${sess.data.name}" добавлен! ID: ${id}\nЦена: ${sess.data.price}р. | Себестоимость: ${sess.data.cost}р.`);
    }
    return;
  }
}

// --- Добавление авто организации ---
const orgVehSessions = new Map();
async function startAddOrgVehicle(vkId) {
  orgVehSessions.set(vkId, { step: 'name' });
  send1(vkId, 'Введите название автомобиля организации:');
}

// --- Промокоды ---
async function startPromoAdd(vkId, org, staff) {
  promoAddSessions.set(vkId, { step: 'code', org, data: {} });
  const types = org === 'delivery'
    ? 'Типы:\n1. discount_pct — скидка %\n2. discount_abs — скидка руб.\n3. free_product — бесплатный товар\n4. free_category — бесплатный из категории\n5. discount_product_pct — скидка % на товар\n6. discount_product_abs — скидка руб. на товар'
    : 'Типы:\n1. discount_pct — скидка %\n2. discount_abs — скидка руб.\n3. free_ride — бесплатная поездка';
  send1(vkId, `Добавление промокода (${org}).\n${types}\n\nВведите код промокода:`);
}

async function handlePromoAdd(vkId, text, atts, org) {
  const sess = promoAddSessions.get(vkId);
  if (!sess) return;
  if (text === 'Отмена') { promoAddSessions.delete(vkId); return send1(vkId, 'Отменено.'); }

  if (sess.step === 'code') {
    sess.data.code = text.trim().toUpperCase();
    sess.step = 'type'; promoAddSessions.set(vkId, sess);
    return send1(vkId, 'Введите тип промокода:');
  }
  if (sess.step === 'type') {
    sess.data.type = text.trim().toLowerCase();
    if (['free_ride','free_product','free_category'].includes(sess.data.type) && !['free_ride'].includes(sess.data.type)) {
      sess.step = 'product'; promoAddSessions.set(vkId, sess);
      const list = prodAll().map(p => `${p.id}. ${p.name}`).join('\n');
      return send1(vkId, `Товары:\n${list}\n\nВведите ID товара:`);
    }
    sess.step = 'value'; promoAddSessions.set(vkId, sess);
    return send1(vkId, 'Введите значение (% или рублей), или 0 если не нужно:');
  }
  if (sess.step === 'product') {
    sess.data.product_id = parseInt(text)||null;
    sess.step = 'value'; promoAddSessions.set(vkId, sess);
    return send1(vkId, 'Введите значение скидки (0 если нет):');
  }
  if (sess.step === 'value') {
    sess.data.value = parseInt(text)||0;
    sess.step = 'uses'; promoAddSessions.set(vkId, sess);
    return send1(vkId, 'Введите количество использований (-1 = безлимит):');
  }
  if (sess.step === 'uses') {
    sess.data.uses_left = parseInt(text);
    sess.step = 'expires'; promoAddSessions.set(vkId, sess);
    return send1(vkId, 'Введите дату истечения в формате ДД.ММ.ГГГГ или "нет":',
      { keyboard: kb([[{ action:{ type:'text', label:'нет' } }]], false) }
    );
  }
  if (sess.step === 'expires') {
    let expires = null;
    if (text !== 'нет') {
      const [d,m,y] = text.split('.');
      expires = new Date(`${y}-${m}-${d}`).getTime();
    }
    promoAdd({ code: sess.data.code, org: sess.org, type: sess.data.type, value: sess.data.value, product_id: sess.data.product_id||null, uses_left: sess.data.uses_left, expires_at: expires, created_by: vkId });
    promoAddSessions.delete(vkId);
    return send1(vkId, `Промокод "${sess.data.code}" добавлен!`);
  }
}

async function sendPromoList(vkId, org) {
  const list = promoAll(org);
  if (!list.length) return send1(vkId, `Промокодов ${org} нет.`);
  const txt = list.map(p => `${p.code} [${p.type}] val=${p.value} uses=${p.uses_left}`).join('\n');
  send1(vkId, `Промокоды (${org}):\n${txt}`);
}

async function sendProductList(vkId) {
  const cats = catAll();
  let txt = 'Товары по категориям:\n';
  for (const c of cats) {
    const prods = prodAll(c.id);
    if (!prods.length) continue;
    txt += `\n[${c.name}]\n`;
    prods.forEach(p => { txt += `  ${p.id}. ${p.name} | ${p.price}р. (себест. ${p.cost}р.)\n`; });
  }
  const sets = setAll();
  if (sets.length) {
    txt += '\n[Сеты]\n';
    sets.forEach(s => { txt += `  С${s.id}. ${s.name} | ${s.price}р.\n`; });
  }
  send1(vkId, txt || 'Товаров нет.');
}

async function sendStaffList(vkId) {
  const all = staffGetAll();
  if (!all.length) return send1(vkId, 'Сотрудников нет.');
  const txt = all.map(s => `[id${s.vk_id}|${s.nick}] ${roleDisplayShort(s.role)} | заказов: ${s.orders_done}`).join('\n');
  send1(vkId, `Сотрудники (${all.length}):\n${txt}`);
}

async function sendOnlineStats(vkId) {
  const all = staffGetAll();
  let txt = 'Онлайн за 7 дней:\n';
  for (const s of all) {
    const rows = [];
    for (let i = 6; i >= 0; i--) {
      const ds = dateMSK(Date.now()-i*86400000).split(' ')[0];
      const r = q('SELECT seconds FROM online_stats WHERE vk_id=? AND date_str=?').get(s.vk_id, ds);
      if (r) rows.push(`${ds}: ${Math.floor(r.seconds/3600)}ч.${Math.floor((r.seconds%3600)/60)}м.`);
    }
    if (rows.length) txt += `\n${s.nick}:\n${rows.join('\n')}\n`;
  }
  send1(vkId, txt);
}

// ─── ОБРАБОТЧИК САМОЛИВА / ВХОЖДЕНИЯ В ЧАТ ───────────────────────────────────
async function handleChatJoin(msg) {
  const userId = msg.action.member_id;
  const ban = blGet(userId);
  if (ban) {
    try { await api1('messages.removeChatUser', { chat_id: peerToChatId(msg.peer_id), member_id: userId }); }
    catch {}
    await send1(msg.peer_id, `Пользователь ID${userId} автоматически удалён (в ЧС до ${fmtBanDate(ban.end_date)})`);
    return;
  }
  const gr = greetings.get(msg.peer_id);
  if (gr) {
    const u = await getUser(userId);
    const txt = gr.text.replace('{user}', u ? userLink(u) : `ID${userId}`);
    await send1(msg.peer_id, txt, gr.attachments?.length ? { attachment: gr.attachments.join(',') } : {});
  }
}

async function handleChatLeave(msg) {
  const userId = msg.action.member_id;
  if (msg.from_id !== userId) return; // Кик, не самолив
  const u = await getUser(userId);
  const uLink = u ? userLink(u) : `ID${userId}`;
  const chats = Object.values(CHATS).filter(id => id > 0);
  for (const pid of chats) {
    try { await api1('messages.removeChatUser', { chat_id: peerToChatId(pid), member_id: userId }); } catch {}
  }
  const kbSelf = kb([
    [{ action:{ type:'callback', label:'30 дней', payload: JSON.stringify({ action:'ban', userId, days:30 }) }, color:'secondary' },
     { action:{ type:'callback', label:'60 дней', payload: JSON.stringify({ action:'ban', userId, days:60 }) }, color:'secondary' }],
    [{ action:{ type:'callback', label:'Перманент', payload: JSON.stringify({ action:'ban', userId, days:0 }) }, color:'negative' },
     { action:{ type:'callback', label:'Не банить', payload: JSON.stringify({ action:'return', userId }) }, color:'positive' }],
  ], true);
  await send1(CHATS.rukovodstvo, `[${fmtDate()}] [САМОЛИВ]\n${uLink} покинул беседу\n\nЗанести в ЧС?`, { keyboard: kbSelf });
}

// ─── CALLBACK (Группа 1) ─────────────────────────────────────────────────────
async function handleG1Callback(event) {
  const payload = typeof event.object.payload === 'string' ? JSON.parse(event.object.payload) : event.object.payload;
  const peerId  = event.object.peer_id;
  const cmid    = event.object.conversation_message_id;
  const actorId = event.object.user_id;

  // Самолив
  if (payload.action === 'ban') {
    const days = payload.days;
    const mod = await getUser(actorId);
    const modName = mod ? `${mod.first_name} ${mod.last_name}` : `ID${actorId}`;
    blAdd(payload.userId, days, `Самолив (${modName})`, actorId);
    const end = days === 0 ? 0 : Date.now() + days*86400000;
    await edit1(peerId, cmid, `[${fmtDate()}] [САМОЛИВ]\nID${payload.userId} покинул беседу\nОбработано: в ЧС до ${fmtBanDate(end)}`);
    await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId });
    return;
  }
  if (payload.action === 'return') {
    await edit1(peerId, cmid, `[${fmtDate()}] [САМОЛИВ]\nID${payload.userId} покинул беседу\nОбработано: НЕ добавлен в ЧС`);
    await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId });
    return;
  }

  // Принятие заказа доставки в диспетчерской
  if (payload.action === 'accept_order') {
    await handleAcceptOrder(payload, event, peerId, cmid, actorId);
    return;
  }

  // Принятие заказа такси
  if (payload.action === 'accept_taxi') {
    await handleAcceptTaxi(payload, event, peerId, cmid, actorId);
    return;
  }

  // Помощник курьера: отметить куплено
  if (payload.action === 'mark_bought') {
    await handleMarkBought(payload, event, peerId, cmid, actorId);
    return;
  }

  // Заказ готовится -> едет
  if (payload.action === 'order_delivering') {
    await handleOrderDelivering(payload, event, peerId, cmid, actorId);
    return;
  }

  // Курьер на месте
  if (payload.action === 'order_arrived') {
    await handleOrderArrived(payload, event, peerId, cmid, actorId);
    return;
  }

  // Заказ завершён
  if (payload.action === 'order_done') {
    await handleOrderDone(payload, event, peerId, cmid, actorId);
    return;
  }

  // Отчёт обработан
  if (payload.action === 'report_done') {
    await edit1(peerId, cmid, `[${fmtDate()}] Отчёт обработан`);
    await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId });
    return;
  }

  // Такси: статусы
  if (payload.action === 'taxi_waiting')    { await handleTaxiWaiting(payload, event, peerId, cmid, actorId); return; }
  if (payload.action === 'taxi_driving')    { await handleTaxiDriving(payload, event, peerId, cmid, actorId); return; }
  if (payload.action === 'taxi_arrived')    { await handleTaxiArrived(payload, event, peerId, cmid, actorId); return; }
  if (payload.action === 'taxi_done')       { await handleTaxiDone(payload, event, peerId, cmid, actorId); return; }

  // Универсальный ответ
  try { await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId }); } catch {}
}

// ─── ДИСПЕТЧЕРСКАЯ: ПРИНЯТИЕ ЗАКАЗА ─────────────────────────────────────────
async function handleAcceptOrder(payload, event, peerId, cmid, actorId) {
  const orderId = payload.orderId;
  const order = orderGet(orderId);
  if (!order || order.status !== 'pending') {
    try { await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId }); } catch {}
    return;
  }
  const staff = staffGet(actorId);
  if (!staff) { return send1(actorId, 'Создайте профиль сотрудника для принятия заказов.'); }
  const vehicles = vehicleGetAll(actorId);
  if (!vehicles.length) { return send1(actorId, 'Добавьте автомобиль в автопарк для принятия заказов.'); }

  // Курьер нажал принять — переходит в ЛС Группы 1, вводит ник и время
  courierAcceptSessions.set(actorId, { orderId, step: 'nick', data: {} });
  await send1(actorId, `Принятие заказа #${orderId}.\n\nШаг 1/2: Введите ваш игровой ник (или подтвердите "${staff.nick}"):`,
    { keyboard: kb([[{ action:{ type:'text', label: staff.nick } }]], false) }
  );
  try { await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId }); } catch {}
}

const courierAcceptSessions = new Map(); // actorId -> { orderId, step, data }

async function handleCourierAcceptDM(vkId, text) {
  const sess = courierAcceptSessions.get(vkId);
  if (!sess) return false;
  const { orderId } = sess;

  if (sess.step === 'nick') {
    sess.data.nick = text.trim();
    sess.step = 'eta';
    courierAcceptSessions.set(vkId, sess);
    await send1(vkId, 'Шаг 2/2: Введите примерное время ожидания (в минутах):');
    return true;
  }
  if (sess.step === 'eta') {
    const eta = parseInt(text) || 15;
    sess.data.eta = eta;
    courierAcceptSessions.delete(vkId);

    const order = orderGet(orderId);
    if (!order) { await send1(vkId, 'Заказ не найден.'); return true; }

    const staff = staffGet(vkId);
    orderUpdate(orderId, { status:'preparing', courier_vk_id: vkId, courier_nick: sess.data.nick, eta_minutes: eta });

    // Обновить сообщение в диспетчерской
    if (order.dispatch_msg_id) {
      const items = orderItemsGet(orderId);
      const helperTxt = buildHelperMessage(order, items, eta);
      const helperKb = buildHelperKeyboard(orderId, items);
      const newDispTxt = `[ПРИНЯТ #${orderId}]\n${order.client_nick} @${order.location}\nКурьер: ${sess.data.nick} | ETA: ${eta} мин.`;
      await edit1(CHATS.dispetcherskaya, order.dispatch_msg_id, newDispTxt, { keyboard: helperKb });
      // Помощник курьера — отдельное сообщение в диспетчерской
      const helpMsgId = await send1(CHATS.dispetcherskaya, helperTxt, { keyboard: helperKb });
      if (helpMsgId) orderUpdate(orderId, { helper_msg_id: helpMsgId });
    }

    // Уведомить клиента в ЛС Группы 2
    await send2(order.client_vk_id, `Ваш курьер: ${sess.data.nick}\nПримерное время ожидания: ${eta} минут.\n\nСтатус заказа: Готовится`);

    await send1(vkId, `Заказ #${orderId} принят!\nКлиент: ${order.client_nick}\nАдрес: ${order.location}\n\nЗаказ готовится. Отмечайте покупки в диспетчерской.`);
    return true;
  }
  return false;
}

function buildHelperMessage(order, items, eta) {
  const bought = items.filter(i => i.bought);
  const notBought = items.filter(i => !i.bought);
  let txt = `Помощник курьера — Заказ #${order.id}\nКлиент: ${order.client_nick}\nАдрес: ${order.location}\nETA: ${eta || order.eta_minutes} мин.\n\n`;
  if (notBought.length) {
    txt += 'Купить:\n';
    for (const it of notBought) {
      if (it.product_id) {
        const p = prodGet(it.product_id);
        const si = p ? JSON.parse(p.simple_items||'[]') : [];
        txt += si.length ? `  ${it.name} (${si.map(s=>`${s.name} x${s.qty}`).join(', ')})\n` : `  ${it.name} x${it.qty}\n`;
      } else { txt += `  ${it.name} x${it.qty}\n`; }
    }
  }
  if (bought.length) { txt += '\nКуплено:\n'; bought.forEach(i => { txt += `  [v] ${i.name}\n`; }); }
  return txt;
}

function buildHelperKeyboard(orderId, items) {
  const notBought = items.filter(i => !i.bought);
  const rows = [];
  for (const it of notBought) {
    rows.push([{ action:{ type:'callback', label:`Куплено: ${it.name.substring(0,15)}`, payload: JSON.stringify({ action:'mark_bought', orderId, itemId: it.id }) }, color:'primary' }]);
  }
  rows.push([
    { action:{ type:'callback', label:'Заказ готов, еду', payload: JSON.stringify({ action:'order_delivering', orderId }) }, color:'positive' },
  ]);
  return JSON.stringify({ inline: true, buttons: rows });
}

async function handleMarkBought(payload, event, peerId, cmid, actorId) {
  const { orderId, itemId } = payload;
  orderItemUpdate(itemId, { bought: 1 });
  const order = orderGet(orderId);
  const items  = orderItemsGet(orderId);
  const newTxt = buildHelperMessage(order, items, order.eta_minutes);
  const newKb  = buildHelperKeyboard(orderId, items);
  await edit1(peerId, cmid, newTxt, { keyboard: newKb });
  try { await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId }); } catch {}
}

async function handleOrderDelivering(payload, event, peerId, cmid, actorId) {
  const { orderId } = payload;
  const order = orderGet(orderId);
  if (!order) return;
  orderUpdate(orderId, { status: 'delivering' });
  const items = orderItemsGet(orderId);
  const txt = `[ЕДЕТ #${orderId}]\nКлиент: ${order.client_nick}\nАдрес: ${order.location}\nСумма: ${order.total_price}р.`;
  await edit1(peerId, cmid, txt, { keyboard: JSON.stringify({ inline:true, buttons:[[
    { action:{ type:'callback', label:'Я на месте', payload: JSON.stringify({ action:'order_arrived', orderId }) }, color:'positive' }
  ]] }) });
  // Уведомить клиента
  await send2(order.client_vk_id, 'Ваш заказ готов! Курьер едет к вам.');
  await send1(actorId, `Заказ #${orderId} — напоминание:\nКлиент: ${order.client_nick}\nАдрес: ${order.location}\nСумма: ${order.total_price}р.`);
  try { await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId }); } catch {}
}

async function handleOrderArrived(payload, event, peerId, cmid, actorId) {
  const { orderId } = payload;
  const order = orderGet(orderId);
  if (!order) return;
  orderUpdate(orderId, { status: 'arrived' });
  await edit1(peerId, cmid, `[НА МЕСТЕ #${orderId}]\nКлиент: ${order.client_nick}`, { keyboard: JSON.stringify({ inline:true, buttons:[[
    { action:{ type:'callback', label:'Заказ выдан', payload: JSON.stringify({ action:'order_done', orderId }) }, color:'positive' }
  ]] }) });
  await send2(order.client_vk_id, 'Курьер прибыл! Получите ваш заказ.');
  try { await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId }); } catch {}
}

async function handleOrderDone(payload, event, peerId, cmid, actorId) {
  const { orderId } = payload;
  const order = orderGet(orderId);
  if (!order) return;
  orderUpdate(orderId, { status: 'done' });
  await edit1(peerId, cmid, `[ВЫПОЛНЕН #${orderId}]\nКлиент: ${order.client_nick} | Сумма: ${order.total_price}р.`);
  // Обновить статистику
  if (order.courier_vk_id) staffUpdate(order.courier_vk_id, { orders_done: (staffGet(order.courier_vk_id)?.orders_done||0)+1, orders_week: (staffGet(order.courier_vk_id)?.orders_week||0)+1 });
  statsIncOrder('delivery', order.total_price, order.total_cost);
  // Уведомить клиента
  await send2(order.client_vk_id, 'Заказ выполнен! Спасибо. Можете оставить отзыв.');
  try { await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId }); } catch {}
}

// ─── ДИСПЕТЧЕРСКАЯ: ПРИНЯТИЕ ТАКСИ ──────────────────────────────────────────
async function handleAcceptTaxi(payload, event, peerId, cmid, actorId) {
  const taxiId = payload.taxiId;
  const order  = taxiGet(taxiId);
  if (!order || order.status !== 'pending') {
    try { await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId }); } catch {}
    return;
  }
  const staff = staffGet(actorId);
  if (!staff) return send1(actorId, 'Создайте профиль сотрудника.');
  const vehicles = vehicleGetAll(actorId);
  if (!vehicles.length) return send1(actorId, 'Добавьте автомобиль в автопарк.');

  taxiDriverSessions.set(actorId, { taxiId, step: 'nick' });
  await send1(actorId, `Принятие поездки #${taxiId}.\nОткуда: ${order.from_name}\nКуда: ${order.to_name}\n\nВаш ник (или подтвердите "${staff.nick}"):`,
    { keyboard: kb([[{ action:{ type:'text', label: staff.nick } }]], false) }
  );
  try { await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId }); } catch {}
}

const taxiDriverSessions = new Map();

async function handleTaxiDriverDM(vkId, text) {
  const sess = taxiDriverSessions.get(vkId);
  if (!sess) return false;
  if (sess.step === 'nick') {
    sess.data = { nick: text.trim() };
    taxiDriverSessions.delete(vkId);
    const taxiId = sess.taxiId;
    const order = taxiGet(taxiId);
    if (!order) return true;
    taxiUpdate(taxiId, { status:'accepted', driver_vk_id: vkId, driver_nick: sess.data.nick });
    if (order.dispatch_msg_id) {
      await edit1(CHATS.dispetcherskaya_taxi||CHATS.dispetcherskaya, order.dispatch_msg_id, `[ПРИНЯТ #${taxiId}]\nОткуда: ${order.from_name}\nКуда: ${order.to_name}\nВодитель: ${sess.data.nick}`,
        { keyboard: JSON.stringify({ inline:true, buttons:[
          [{ action:{ type:'callback', label:'Платное ожидание', payload:JSON.stringify({ action:'taxi_waiting', taxiId }) }, color:'secondary' }],
          [{ action:{ type:'callback', label:'Еду к клиенту',   payload:JSON.stringify({ action:'taxi_driving', taxiId }) }, color:'primary' }],
          [{ action:{ type:'callback', label:'На месте',        payload:JSON.stringify({ action:'taxi_arrived', taxiId }) }, color:'positive' }],
          [{ action:{ type:'callback', label:'Завершить',       payload:JSON.stringify({ action:'taxi_done',    taxiId }) }, color:'positive' }],
        ] }) }
      );
    }
    await send3(order.client_vk_id, `Ваш водитель: ${sess.data.nick}\nОн скоро будет. Откуда: ${order.from_name} → Куда: ${order.to_name}`);
    await send1(vkId, `Поездка #${taxiId} принята!\nОткуда: ${order.from_name}\nКуда: ${order.to_name}\nСумма: ${order.total_price}р.`);
    return true;
  }
  return false;
}

async function handleTaxiWaiting(payload, event, peerId, cmid, actorId) {
  const { taxiId } = payload;
  const order = taxiGet(taxiId);
  if (!order) return;
  taxiUpdate(taxiId, { status:'waiting', paid_waiting: (order.paid_waiting||0)+1 });
  const rate = parseInt(getSetting('taxi_waiting_rate_per_min')||'10');
  await edit1(peerId, cmid, `[ПЛАТНОЕ ОЖИДАНИЕ #${taxiId}] +${rate}р./мин.`);
  await send3(order.client_vk_id, `Водитель ожидает. Платное ожидание: ${rate}р./мин.`);
  try { await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId }); } catch {}
}

async function handleTaxiDriving(payload, event, peerId, cmid, actorId) {
  const { taxiId } = payload; const order = taxiGet(taxiId); if (!order) return;
  taxiUpdate(taxiId, { status:'driving' });
  await send3(order.client_vk_id, 'Водитель выехал к вам!');
  try { await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId }); } catch {}
}

async function handleTaxiArrived(payload, event, peerId, cmid, actorId) {
  const { taxiId } = payload; const order = taxiGet(taxiId); if (!order) return;
  taxiUpdate(taxiId, { status:'arrived' });
  await send3(order.client_vk_id, 'Водитель прибыл! Выходите.');
  try { await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId }); } catch {}
}

async function handleTaxiDone(payload, event, peerId, cmid, actorId) {
  const { taxiId } = payload; const order = taxiGet(taxiId); if (!order) return;
  taxiUpdate(taxiId, { status:'done' });
  if (order.driver_vk_id) staffUpdate(order.driver_vk_id, { orders_done: (staffGet(order.driver_vk_id)?.orders_done||0)+1, orders_week: (staffGet(order.driver_vk_id)?.orders_week||0)+1 });
  statsIncOrder('taxi', order.total_price, 0);
  await edit1(peerId, cmid, `[ЗАВЕРШЕНА #${taxiId}] ${order.from_name} → ${order.to_name} | ${order.total_price}р.`);
  await send3(order.client_vk_id, 'Поездка завершена! Спасибо.');
  try { await api1('messages.sendMessageEventAnswer', { event_id:event.object.event_id, user_id:actorId, peer_id:peerId }); } catch {}
}

// ─── ГЛАВНЫЙ ОБРАБОТЧИК СОБЫТИЙ ГРУППЫ 1 ─────────────────────────────────────
async function handleG1Event(event) {
  try {
    if (event.type === 'message_new' && event.object?.message) {
      const msg  = event.object.message;
      const from = msg.from_id;
      const peer = msg.peer_id;
      const text = (msg.text||'').trim();

      // Чат: события вхождения/выхода
      if (msg.action) {
        if (msg.action.type === 'chat_invite_user')  await handleChatJoin(msg);
        if (msg.action.type === 'chat_kick_user')    await handleChatLeave(msg);
        return;
      }

      // Мут — удалить сообщение
      if (muteGet(from)) {
        try { await api1('messages.delete', { peer_id:peer, delete_for_all:1, cmids: String(msg.conversation_message_id) }); } catch {}
        return;
      }

      // ЛС сотрудника (peer_id = vk_id, то есть меньше 2 млрд и не чат)
      if (peer === from) {
        // Сессии принятия заказа
        if (await handleCourierAcceptDM(from, text)) return;
        if (await handleTaxiDriverDM(from, text))    return;
        // Сессии добавления авто организации
        if (orgVehSessions.has(from)) {
          const vs = orgVehSessions.get(from);
          if (vs.step === 'name') {
            vs.data = { name: text.trim() }; vs.step = 'photo';
            orgVehSessions.set(from, vs);
            await send1(from, 'Пришлите фото автомобиля (или "Нет"):', { keyboard: kb([[{ action:{ type:'text', label:'Нет' } }]], false) });
            return;
          }
          if (vs.step === 'photo') {
            const atts = msg.attachments||[];
            let photoUrl = null;
            if (atts.length && atts[0].type === 'photo') {
              const ph = atts[0].photo;
              photoUrl = `photo${ph.owner_id}_${ph.id}`;
            }
            orgVehicleAdd(vs.data.name, photoUrl, from);
            orgVehSessions.delete(from);
            await send1(from, `Авто "${vs.data.name}" добавлено в парк организации.`);
            return;
          }
        }
        await handleG1DM(msg);
        return;
      }

      // Чат: Журнал Активности
      if (await handleActivityLog(msg)) return;

      // Чат: команды !
      if (text.startsWith('!')) {
        const parts = text.split(/\s+/);
        const cmd   = parts[0].slice(1).toLowerCase();
        const ctx   = { message:msg, userId:from, peerId:peer, args:parts, replyMsg:msg.reply_message };
        const cmds  = {
          пост: cmdPost, приказ: cmdPrikaz, приветствие: cmdGreeting, закреп: cmdPin,
          кик: cmdKick, чат: cmdChatInfo, увед: cmdNotify, диагностика: cmdDiagnostics,
          чс: cmdBlacklist, мут: cmdMute, размут: cmdUnmute, стата: cmdStata,
          профиль: cmdProfile,
        };
        if (cmds[cmd]) await cmds[cmd](ctx);
      }
    }

    if (event.type === 'message_event') await handleG1Callback(event);

    if (event.type === 'wall_post_new' && event.object) {
      const post = event.object;
      if (Math.abs(post.owner_id) === parseInt(G1_ID) && CHATS.doska) {
        await send1(CHATS.doska, '', { attachment: `wall${post.owner_id}_${post.id}` });
      }
    }
  } catch(e) { console.error('[G1 event error]', e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ГРУППА 2: ЛС КЛИЕНТОВ ДОСТАВКИ
// ═══════════════════════════════════════════════════════════════════════════════

async function handleG2Event(event) {
  try {
    if (event.type !== 'message_new' || !event.object?.message) return;
    const msg  = event.object.message;
    const from = msg.from_id;
    const text = (msg.text||'').trim();
    const atts = msg.attachments||[];
    await handleDeliveryClient(from, text, atts, msg);
  } catch(e) { console.error('[G2 event error]', e.message); }
}

async function handleDeliveryClient(vkId, text, atts, msg) {
  let sess = clientSessionsG2.get(vkId);

  // Ожидание скрина оплаты
  if (sess?.step === 'payment_proof') {
    if (atts.length && atts[0].type === 'photo') {
      const ph = atts[0].photo;
      const proofUrl = `photo${ph.owner_id}_${ph.id}`;
      const orderId = sess.data.orderId;
      orderUpdate(orderId, { payment_proof: proofUrl, status:'pending' });
      await dispatchDeliveryOrder(orderId);
      clientSessionsG2.delete(vkId);
      await edit2(vkId, sess.msgId, 'Оплата подтверждена! Ожидайте принятия заказа.');
      return;
    }
    return send2(vkId, 'Пришлите скриншот оплаты (фото).');
  }

  // Ожидание скрина для ссылки клиента/курьера
  // (обрабатывается через сессию link_request)

  if (!sess) {
    sess = { step: 'main', data: {}, msgId: null };
    clientSessionsG2.set(vkId, sess);
  }

  if (sess.step === 'main' || text === 'Главное меню' || text === 'Назад' || text === 'Начать') {
    return sendDeliveryMain(vkId);
  }

  if (text === 'Каталог') return sendCatalogMenu(vkId, null);
  if (text === 'Заказать') return startOrder(vkId);
  if (text === 'Трудоустройство') {
    await send2(vkId, 'Для трудоустройства в нашу организацию, напишите в личные сообщения сообщества 1. Мы всегда рады новым сотрудникам!',
      { keyboard: kb([[{ action:{ type:'text', label:'Назад' } }]], false) }
    );
    return;
  }
  if (text === 'Частые вопросы') {
    await send2(vkId, 'Часто задаваемые вопросы:\n\n— Как сделать заказ? Нажмите "Заказать" в главном меню.\n— Как отслеживать заказ? Нажмите "Статус заказа" в меню.\n— Минимальный заказ? Нет минимальной суммы.\n— Время доставки? Уточняется при принятии заказа курьером.',
      { keyboard: kb([[{ action:{ type:'text', label:'Назад' } }]], false) }
    );
    return;
  }
  if (text === 'Статус заказа') return sendOrderStatus(vkId);
  if (text === 'Связь с курьером') return handleLinkRequest(vkId, 'delivery');

  // Навигация по каталогу
  if (sess.step === 'catalog') return handleCatalogNav(vkId, text, sess);

  // Навигация по заказу
  if (sess.step && sess.step.startsWith('order_')) return handleOrderFlow(vkId, text, atts, sess);
}

async function sendDeliveryMain(vkId) {
  const rows = [
    [{ action:{ type:'text', label:'Заказать' } }, { action:{ type:'text', label:'Каталог' } }],
    [{ action:{ type:'text', label:'Статус заказа' } }, { action:{ type:'text', label:'Связь с курьером' } }],
    [{ action:{ type:'text', label:'Трудоустройство' } }, { action:{ type:'text', label:'Частые вопросы' } }],
  ];
  clientSessionsG2.set(vkId, { step:'main', data:{}, msgId:null });
  await send2(vkId, 'Добро пожаловать! Выберите действие:', { keyboard: kb(rows, false) });
}

// --- Каталог ---
async function sendCatalogMenu(vkId, parentId) {
  const cats = catAll().filter(c => (c.parent_id||null) === (parentId||null));
  const sess = clientSessionsG2.get(vkId) || { step:'catalog', data:{}, msgId:null };
  sess.step = 'catalog'; sess.data.catParent = parentId;
  clientSessionsG2.set(vkId, sess);
  if (!cats.length) {
    // Показать товары текущей категории (parentId как catId)
    return sendCatalogProducts(vkId, parentId);
  }
  const rows = cats.map(c => [{ action:{ type:'text', label:c.name } }]);
  rows.push([{ action:{ type:'text', label:'Назад' } }]);
  await send2(vkId, 'Выберите категорию:', { keyboard: kb(rows, false) });
}

async function sendCatalogProducts(vkId, catId) {
  const cat = catGet(catId);
  const prods = prodAll(catId);
  if (!prods.length) {
    await send2(vkId, 'В этой категории пока нет товаров.', { keyboard: kb([[{ action:{ type:'text', label:'Назад' } }]], false) });
    return;
  }
  for (const p of prods) {
    const txt = `${p.name}\nЦена: ${p.price}р.`;
    const atts = p.photo_url ? p.photo_url : undefined;
    await send2(vkId, txt, atts ? { attachment: atts } : {});
  }
  await send2(vkId, `Категория: ${cat?.name||''}`, { keyboard: kb([[{ action:{ type:'text', label:'Назад' } }]], false) });
}

async function handleCatalogNav(vkId, text, sess) {
  if (text === 'Назад') {
    return sendDeliveryMain(vkId);
  }
  // Найти категорию по имени
  const cats = catAll();
  const cat = cats.find(c => c.name === text);
  if (cat) return sendCatalogMenu(vkId, cat.id);
  return sendDeliveryMain(vkId);
}

// --- Заказ ---
async function startOrder(vkId) {
  const sess = { step:'order_cats', data:{ cart:[], page:0 }, msgId: null };
  clientSessionsG2.set(vkId, sess);
  await sendOrderCats(vkId, sess);
}

async function sendOrderCats(vkId, sess) {
  const cats = catAll();
  const rows = cats.map(c => [{ action:{ type:'text', label:c.name } }]);
  const sets = setAll();
  // Сеты показываем как категорию "Сеты" если не уже в катах
  rows.push([{ action:{ type:'text', label:'Корзина' } }]);
  rows.push([{ action:{ type:'text', label:'Главное меню' } }]);
  const cartTxt = formatCart(sess.data.cart||[], sess.data.discount||0, sess.data.promoCode||null);
  const msgId = await send2(vkId, cartTxt, { keyboard: kb(rows, false) });
  if (msgId) { sess.msgId = msgId; clientSessionsG2.set(vkId, sess); }
}

async function handleOrderFlow(vkId, text, atts, sess) {
  if (text === 'Главное меню') { clientSessionsG2.delete(vkId); return sendDeliveryMain(vkId); }

  // Выбор категории
  if (sess.step === 'order_cats') {
    if (text === 'Корзина') { sess.step = 'order_cart'; clientSessionsG2.set(vkId, sess); return sendCart(vkId, sess); }
    const cats = catAll();
    const cat = cats.find(c => c.name === text);
    if (cat) {
      sess.step = 'order_products';
      sess.data.currentCatId = cat.id;
      sess.data.page = 0;
      clientSessionsG2.set(vkId, sess);
      return sendOrderProducts(vkId, sess);
    }
    return;
  }

  // Выбор товара
  if (sess.step === 'order_products') {
    if (text === 'Назад') { sess.step = 'order_cats'; clientSessionsG2.set(vkId, sess); return sendOrderCats(vkId, sess); }
    if (text === 'Ещё') { sess.data.page = (sess.data.page||0)+1; clientSessionsG2.set(vkId, sess); return sendOrderProducts(vkId, sess); }
    const prods = prodAll(sess.data.currentCatId);
    const prod = prods.find(p => p.name === text || text.startsWith(p.name));
    if (prod) {
      // Добавить в корзину
      const existing = sess.data.cart.find(i => i.product_id === prod.id);
      if (existing) existing.qty++;
      else sess.data.cart.push({ product_id: prod.id, name: prod.name, price: prod.price, cost: prod.cost, qty: 1 });
      clientSessionsG2.set(vkId, sess);
      // Обновить сообщение с корзиной
      const cartTxt = formatCart(sess.data.cart, sess.data.discount||0, sess.data.promoCode||null);
      if (sess.msgId) await edit2(vkId, sess.msgId, cartTxt);
      return sendOrderProducts(vkId, sess);
    }
    return;
  }

  // Корзина
  if (sess.step === 'order_cart') {
    if (text === 'Добавить ещё') { sess.step = 'order_cats'; clientSessionsG2.set(vkId, sess); return sendOrderCats(vkId, sess); }
    if (text === 'Удалить товар') { sess.step = 'order_remove'; clientSessionsG2.set(vkId, sess); return sendRemoveItem(vkId, sess); }
    if (text === 'Очистить корзину') {
      sess.data.cart = []; sess.data.discount = 0; sess.data.promoCode = null;
      clientSessionsG2.set(vkId, sess);
      if (sess.msgId) await edit2(vkId, sess.msgId, 'Корзина очищена.');
      return sendOrderCats(vkId, sess);
    }
    if (text === 'Оформить заказ') {
      if (!sess.data.cart.length) return send2(vkId, 'Корзина пуста.');
      sess.step = 'order_nick'; clientSessionsG2.set(vkId, sess);
      if (sess.msgId) await edit2(vkId, sess.msgId, formatCart(sess.data.cart, sess.data.discount||0, sess.data.promoCode||null)+'\n\nВведите ваш никнейм:');
      return;
    }
    if (text === 'Назад') { sess.step = 'order_cats'; clientSessionsG2.set(vkId, sess); return sendOrderCats(vkId, sess); }
    return;
  }

  // Удалить товар
  if (sess.step === 'order_remove') {
    if (text === 'Назад') { sess.step = 'order_cart'; clientSessionsG2.set(vkId, sess); return sendCart(vkId, sess); }
    const idx = parseInt(text)-1;
    if (!isNaN(idx) && sess.data.cart[idx]) {
      sess.data.cart.splice(idx, 1);
      clientSessionsG2.set(vkId, sess);
      sess.step = 'order_cart';
      if (sess.msgId) await edit2(vkId, sess.msgId, formatCart(sess.data.cart, sess.data.discount||0, sess.data.promoCode||null));
      return sendCart(vkId, sess);
    }
    // По имени
    const idx2 = sess.data.cart.findIndex(i => i.name === text);
    if (idx2 !== -1) { sess.data.cart.splice(idx2,1); sess.step='order_cart'; clientSessionsG2.set(vkId,sess); if(sess.msgId) await edit2(vkId,sess.msgId,formatCart(sess.data.cart,0,null)); return sendCart(vkId,sess); }
    return;
  }

  // Ввод ника
  if (sess.step === 'order_nick') {
    sess.data.nick = text.trim(); sess.step = 'order_location'; clientSessionsG2.set(vkId, sess);
    if (sess.msgId) await edit2(vkId, sess.msgId, formatCart(sess.data.cart,sess.data.discount||0,sess.data.promoCode||null)+'\n\nКуда доставить? Введите адрес:');
    return;
  }

  // Адрес
  if (sess.step === 'order_location') {
    sess.data.location = text.trim(); sess.step = 'order_confirm'; clientSessionsG2.set(vkId, sess);
    const total = sess.data.cart.reduce((s,i)=>s+i.price*i.qty,0);
    const confirmTxt = `Подтвердите заказ:\nНик: ${sess.data.nick}\nАдрес: ${sess.data.location}\n\n${formatCart(sess.data.cart,sess.data.discount||0,sess.data.promoCode||null)}`;
    if (sess.msgId) await edit2(vkId, sess.msgId, confirmTxt, { keyboard: kb([[{ action:{ type:'text', label:'Подтвердить' } },{ action:{ type:'text', label:'Изменить' } }]], false) });
    return;
  }

  // Подтверждение
  if (sess.step === 'order_confirm') {
    if (text === 'Изменить') { sess.step = 'order_nick'; clientSessionsG2.set(vkId, sess); if(sess.msgId) await edit2(vkId,sess.msgId,formatCart(sess.data.cart,0,null)+'\n\nВведите ваш никнейм:'); return; }
    if (text === 'Подтвердить') {
      sess.step = 'order_promo'; clientSessionsG2.set(vkId, sess);
      if (sess.msgId) await edit2(vkId, sess.msgId, formatCart(sess.data.cart,sess.data.discount||0,sess.data.promoCode||null)+'\n\nЕсть промокод? Введите его или пропустите:', { keyboard: kb([[{ action:{ type:'text', label:'Пропустить' } }]], false) });
      return;
    }
    return;
  }

  // Промокод
  if (sess.step === 'order_promo') {
    if (text !== 'Пропустить') {
      const promo = promoGet(text.trim().toUpperCase(), 'delivery');
      if (promo) {
        const total = sess.data.cart.reduce((s,i)=>s+i.price*i.qty,0);
        const { discount, needChoose } = applyPromo(promo, sess.data.cart, total);
        sess.data.promoCode = promo.code;
        sess.data.promoId   = promo.id;
        sess.data.discount  = discount;
        if (needChoose) {
          // Категория — нужно выбрать товар
          const prods = prodAll(promo.category_id);
          sess.step = 'order_promo_choose';
          clientSessionsG2.set(vkId, sess);
          const rows = prods.map(p => [{ action:{ type:'text', label:p.name } }]);
          if (sess.msgId) await edit2(vkId, sess.msgId, `Выберите бесплатный товар из категории:`, { keyboard: kb(rows, false) });
          return;
        }
        if (sess.msgId) await edit2(vkId, sess.msgId, `Промокод принят! Скидка: ${discount}р.\n\n${formatCart(sess.data.cart,discount,promo.code)}`);
      } else {
        if (sess.msgId) await edit2(vkId, sess.msgId, 'Промокод не найден или недействителен. Продолжаем без скидки.');
      }
    }
    sess.step = 'order_payment'; clientSessionsG2.set(vkId, sess);
    const total = sess.data.cart.reduce((s,i)=>s+i.price*i.qty,0) - (sess.data.discount||0);
    const bankComm = parseInt(getSetting('bank_commission_pct')||'5');
    if (sess.msgId) await edit2(vkId, sess.msgId, `${formatCart(sess.data.cart,sess.data.discount||0,sess.data.promoCode||null)}\n\nВыберите способ оплаты:\n(Банк. счёт — комиссия ${bankComm}%)`, { keyboard: kb([[{ action:{ type:'text', label:'Наличными' } },{ action:{ type:'text', label:'Банковский счёт' } }]], false) });
    return;
  }

  // Выбор товара из категории по промокоду
  if (sess.step === 'order_promo_choose') {
    const p = prodAll().find(pr => pr.name === text);
    if (p) {
      sess.data.discount = p.price;
      sess.data.cart.push({ product_id: p.id, name: `${p.name} (бесплатно)`, price: 0, cost: p.cost, qty: 1 });
    }
    sess.step = 'order_payment'; clientSessionsG2.set(vkId, sess);
    const total = sess.data.cart.reduce((s,i)=>s+i.price*i.qty,0);
    if (sess.msgId) await edit2(vkId, sess.msgId, `${formatCart(sess.data.cart,0,sess.data.promoCode||null)}\n\nВыберите способ оплаты:`, { keyboard: kb([[{ action:{ type:'text', label:'Наличными' } },{ action:{ type:'text', label:'Банковский счёт' } }]], false) });
    return;
  }

  // Оплата
  if (sess.step === 'order_payment') {
    if (text === 'Наличными') {
      // Создать заказ
      await finalizeDeliveryOrder(vkId, sess, 'cash');
      return;
    }
    if (text === 'Банковский счёт') {
      const total = sess.data.cart.reduce((s,i)=>s+i.price*i.qty,0) - (sess.data.discount||0);
      const bankComm = parseInt(getSetting('bank_commission_pct')||'5');
      const withComm = Math.round(total * (1 + bankComm/100));
      const bankAcc  = getSetting('bank_account')||'852006';
      sess.step = 'payment_proof'; clientSessionsG2.set(vkId, sess);
      if (sess.msgId) await edit2(vkId, sess.msgId, `Переведите ${withComm}р. (с комиссией ${bankComm}%) на счёт ${bankAcc}.\n\nПришлите скриншот с /timestamp или временем над HUD:`);
      return;
    }
    return;
  }
}

async function sendCart(vkId, sess) {
  const cartTxt = formatCart(sess.data.cart||[], sess.data.discount||0, sess.data.promoCode||null);
  const rows = [
    [{ action:{ type:'text', label:'Добавить ещё' } }, { action:{ type:'text', label:'Удалить товар' } }],
    [{ action:{ type:'text', label:'Очистить корзину' } }, { action:{ type:'text', label:'Оформить заказ' } }],
    [{ action:{ type:'text', label:'Назад' } }],
  ];
  if (sess.msgId) await edit2(vkId, sess.msgId, cartTxt, { keyboard: kb(rows, false) });
  else {
    const msgId = await send2(vkId, cartTxt, { keyboard: kb(rows, false) });
    if (msgId) { sess.msgId = msgId; clientSessionsG2.set(vkId, sess); }
  }
}

async function sendOrderProducts(vkId, sess) {
  const prods = prodAll(sess.data.currentCatId);
  const PAGE_SIZE = 6;
  const page = sess.data.page || 0;
  const slice = prods.slice(page*PAGE_SIZE, (page+1)*PAGE_SIZE);
  const rows = slice.map(p => [{ action:{ type:'text', label:`${p.name} — ${p.price}р.` } }]);
  if ((page+1)*PAGE_SIZE < prods.length) rows.push([{ action:{ type:'text', label:'Ещё' } }]);
  rows.push([{ action:{ type:'text', label:'Корзина' } }, { action:{ type:'text', label:'Назад' } }]);
  const cartTxt = formatCart(sess.data.cart||[], sess.data.discount||0, sess.data.promoCode||null);
  if (sess.msgId) await edit2(vkId, sess.msgId, cartTxt, { keyboard: kb(rows, false) });
  else {
    const msgId = await send2(vkId, cartTxt, { keyboard: kb(rows, false) });
    if (msgId) { sess.msgId = msgId; clientSessionsG2.set(vkId, sess); }
  }
}

async function sendRemoveItem(vkId, sess) {
  const rows = sess.data.cart.map((it,i) => [{ action:{ type:'text', label:`${i+1}. ${it.name}` } }]);
  rows.push([{ action:{ type:'text', label:'Назад' } }]);
  if (sess.msgId) await edit2(vkId, sess.msgId, 'Выберите товар для удаления:', { keyboard: kb(rows, false) });
}

async function finalizeDeliveryOrder(vkId, sess, paymentType) {
  const total = sess.data.cart.reduce((s,i)=>s+i.price*i.qty,0) - (sess.data.discount||0);
  const totalCost = sess.data.cart.reduce((s,i)=>s+i.cost*i.qty,0);
  const orderId = orderCreate({ client_vk_id:vkId, client_nick:sess.data.nick, location:sess.data.location, payment_type:paymentType, total_price:total, total_cost:totalCost, promo_code:sess.data.promoCode||null, discount_amt:sess.data.discount||0 });
  for (const it of sess.data.cart) {
    orderItemAdd(orderId, it.name, it.price, it.cost, it.qty, it.product_id||null, it.set_id||null);
  }
  if (sess.data.promoId) promoUse(sess.data.promoId);

  // Сохранить msgId корзины
  orderUpdate(orderId, { cart_msg_id: sess.msgId });
  sess.data.orderId = orderId;
  clientSessionsG2.set(vkId, sess);

  if (sess.msgId) await edit2(vkId, sess.msgId, 'Заказ оформлен! Ожидайте принятия.');

  await dispatchDeliveryOrder(orderId);
  clientSessionsG2.delete(vkId);
}

async function dispatchDeliveryOrder(orderId) {
  const order = orderGet(orderId);
  const items  = orderItemsGet(orderId);
  const itemsTxt = items.map(i => `${i.name} | ${i.price}р. (х${i.qty})`).join('\n');
  const dispTxt  = `[НОВЫЙ ЗАКАЗ #${orderId}]\nНик: ${order.client_nick}\nМесто: ${order.location}\n\n${itemsTxt}\n\nИтого: ${order.total_price}р. (${order.payment_type==='cash'?'наличные':'банк'})`;

  // Проверить наличие курьеров
  const couriers = getOnlineCouriers('delivery');
  if (!couriers.length) {
    await send2(order.client_vk_id, 'К сожалению, сейчас нет курьеров в сети. Попробуйте позже.');
    orderUpdate(orderId, { status:'cancelled' });
    return;
  }

  const dispKb = JSON.stringify({ inline:true, buttons:[[{ action:{ type:'callback', label:'Принять заказ', payload:JSON.stringify({ action:'accept_order', orderId }) }, color:'positive' }]] });
  const msgId = await send1(CHATS.dispetcherskaya, dispTxt, { keyboard: dispKb });
  if (msgId) orderUpdate(orderId, { dispatch_msg_id: msgId });

  // Уведомить курьеров
  await notifyCouriers(CHATS.dispetcherskaya, couriers.map(c=>c.vk_id));

  // Таймер 3 минуты — если не взяли, уведомить СС
  setTimeout(async () => {
    const o = orderGet(orderId);
    if (o && o.status === 'pending') {
      const onlineList = couriers.map(c=>`${c.nick} (${roleDisplayShort(c.role||'kurier')})`).join('\n');
      await send1(CHATS.ss, `[ЗАКАЗ #${orderId} НЕ ПРИНЯТ 3 МИН]\nКурьеры в сети:\n${onlineList}`);
      await notifyCouriers(CHATS.dispetcherskaya, couriers.map(c=>c.vk_id));
    }
  }, 3*60*1000);
}

async function sendOrderStatus(vkId) {
  const orders = ordersByClient(vkId);
  const active = orders.filter(o => !['done','cancelled'].includes(o.status));
  if (!active.length) return send2(vkId, 'У вас нет активных заказов.', { keyboard: kb([[{ action:{ type:'text', label:'Назад' } }]], false) });
  const o = active[0];
  const statusNames = { pending:'Ожидание курьера', accepting:'Принимается', preparing:'Готовится', delivering:'Едет к вам', arrived:'Курьер на месте', done:'Выполнен', cancelled:'Отменён' };
  send2(vkId, `Заказ #${o.id}\nСтатус: ${statusNames[o.status]||o.status}${o.courier_nick?'\nКурьер: '+o.courier_nick:''}${o.eta_minutes?'\nETA: '+o.eta_minutes+' мин.':''}`, { keyboard: kb([[{ action:{ type:'text', label:'Связь с курьером' } },{ action:{ type:'text', label:'Назад' } }]], false) });
}

async function handleLinkRequest(vkId, org) {
  const orders = ordersByClient(vkId);
  const active = orders.filter(o => !['done','cancelled'].includes(o.status));
  if (!active.length) return send2(vkId, 'У вас нет активных заказов.');
  const o = active[0];
  if (!o.courier_vk_id) return send2(vkId, 'Курьер ещё не назначен.');
  await send2(vkId, 'Вы уверены, что хотите связаться с курьером?', {
    keyboard: kb([[{ action:{ type:'text', label:'Да, дать ссылку' } },{ action:{ type:'text', label:'Нет' } }]], false)
  });
  // Запрашиваем согласие курьера
  await send1(o.courier_vk_id, `Клиент ${o.client_nick} запрашивает ссылку на ваши ЛС. Разрешить?`,
    { keyboard: kb([[{ action:{ type:'text', label:`Разрешить #${o.id}` } },{ action:{ type:'text', label:`Отклонить #${o.id}` } }]], false) }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ГРУППА 3: ЛС КЛИЕНТОВ ТАКСИ
// ═══════════════════════════════════════════════════════════════════════════════

async function handleG3Event(event) {
  try {
    if (event.type !== 'message_new' || !event.object?.message) return;
    const msg  = event.object.message;
    const from = msg.from_id;
    const text = (msg.text||'').trim();
    const atts = msg.attachments||[];
    await handleTaxiClient(from, text, atts, msg);
  } catch(e) { console.error('[G3 event error]', e.message); }
}

async function handleTaxiClient(vkId, text, atts, msg) {
  let sess = clientSessionsG3.get(vkId) || { step:'main', data:{}, msgId:null };

  // Ожидание скрина оплаты
  if (sess.step === 'payment_proof') {
    if (atts.length && atts[0].type === 'photo') {
      const ph = atts[0].photo;
      const proofUrl = `photo${ph.owner_id}_${ph.id}`;
      const taxiId = sess.data.taxiId;
      taxiUpdate(taxiId, { payment_proof: proofUrl });
      await dispatchTaxiOrder(taxiId);
      clientSessionsG3.delete(vkId);
      if (sess.msgId) await edit3(vkId, sess.msgId, 'Оплата подтверждена! Ожидайте водителя.');
      return;
    }
    return send3(vkId, 'Пришлите скриншот оплаты.');
  }

  if (!sess) { sess = { step:'main', data:{}, msgId:null }; clientSessionsG3.set(vkId, sess); }

  if (text === 'Назад' || text === 'Главное меню' || text === 'Начать' || !text) {
    clientSessionsG3.set(vkId, { step:'main', data:{}, msgId:null });
    return sendTaxiMain(vkId);
  }
  if (text === 'Заказать авто')       return startTaxiOrder(vkId);
  if (text === 'Трудоустройство') {
    await send3(vkId, 'Для трудоустройства в такси, напишите в личные сообщения сообщества 1.', { keyboard: kb([[{ action:{ type:'text', label:'Назад' } }]], false) });
    return;
  }
  if (text === 'Частые вопросы') {
    await send3(vkId, 'Часто задаваемые вопросы:\n\n— Как рассчитывается цена? По расстоянию между точками (тариф за км) с учётом часов пик.\n— Комиссия: банк. счёт 5%, телефон 7%.\n— Можно ли добавить попутчика? Да, до 2 попутчиков.', { keyboard: kb([[{ action:{ type:'text', label:'Назад' } }]], false) });
    return;
  }

  if (sess.step && sess.step.startsWith('taxi_')) return handleTaxiFlow(vkId, text, atts, sess);
}

async function sendTaxiMain(vkId) {
  const rows = [
    [{ action:{ type:'text', label:'Заказать авто' } }],
    [{ action:{ type:'text', label:'Трудоустройство' } }, { action:{ type:'text', label:'Частые вопросы' } }],
  ];
  await send3(vkId, 'Добро пожаловать в такси! Выберите действие:', { keyboard: kb(rows, false) });
}

async function startTaxiOrder(vkId) {
  const sess = { step:'taxi_nick', data:{ passengers:[] }, msgId:null };
  clientSessionsG3.set(vkId, sess);
  const msgId = await send3(vkId, 'Заказ такси.\n\nШаг 1: Введите ваш игровой никнейм:');
  if (msgId) { sess.msgId = msgId; clientSessionsG3.set(vkId, sess); }
}

async function handleTaxiFlow(vkId, text, atts, sess) {
  if (text === 'Главное меню') { clientSessionsG3.delete(vkId); return sendTaxiMain(vkId); }

  if (sess.step === 'taxi_nick') {
    sess.data.nick = text.trim();
    sess.step = 'taxi_passengers';
    clientSessionsG3.set(vkId, sess);
    if (sess.msgId) await edit3(vkId, sess.msgId, `Ник: ${text.trim()}\n\nДобавить попутчиков? (до 2 никнеймов через запятую, или "Нет"):`, { keyboard: kb([[{ action:{ type:'text', label:'Нет' } }]], false) });
    return;
  }

  if (sess.step === 'taxi_passengers') {
    if (text !== 'Нет') {
      const paxs = text.split(/[,;]/).map(s=>s.trim()).filter(Boolean).slice(0,2);
      sess.data.passengers = paxs;
    }
    sess.step = 'taxi_from_city';
    clientSessionsG3.set(vkId, sess);
    return sendTaxiCities(vkId, sess, 'from');
  }

  if (sess.step === 'taxi_from_city') {
    const city = mapCityAll().find(c => c.name === text);
    if (!city) return send3(vkId, 'Город не найден.');
    sess.data.fromCityId = city.id;
    sess.step = 'taxi_from_cat';
    clientSessionsG3.set(vkId, sess);
    return sendTaxiCats(vkId, sess, 'from', city.id);
  }

  if (sess.step === 'taxi_from_cat') {
    const cat = mapCatAll().find(c => c.name === text);
    if (!cat) return send3(vkId, 'Категория не найдена.');
    sess.data.fromCatId = cat.id;
    sess.step = 'taxi_from_point';
    clientSessionsG3.set(vkId, sess);
    return sendTaxiPoints(vkId, sess, 'from', sess.data.fromCityId, cat.id);
  }

  if (sess.step === 'taxi_from_point') {
    const pts = mapPointsByCityAndCat(sess.data.fromCityId, sess.data.fromCatId);
    const pt = pts.find(p => p.name === text);
    if (!pt) return send3(vkId, 'Точка не найдена.');
    sess.data.fromPointId = pt.id; sess.data.fromName = pt.name; sess.data.fromLat = pt.lat; sess.data.fromLng = pt.lng;
    sess.step = 'taxi_to_city';
    clientSessionsG3.set(vkId, sess);
    return sendTaxiCities(vkId, sess, 'to');
  }

  if (sess.step === 'taxi_to_city') {
    const city = mapCityAll().find(c => c.name === text);
    if (!city) return send3(vkId, 'Город не найден.');
    sess.data.toCityId = city.id;
    sess.step = 'taxi_to_cat';
    clientSessionsG3.set(vkId, sess);
    return sendTaxiCats(vkId, sess, 'to', city.id);
  }

  if (sess.step === 'taxi_to_cat') {
    const cat = mapCatAll().find(c => c.name === text);
    if (!cat) return send3(vkId, 'Категория не найдена.');
    sess.data.toCatId = cat.id;
    sess.step = 'taxi_to_point';
    clientSessionsG3.set(vkId, sess);
    return sendTaxiPoints(vkId, sess, 'to', sess.data.toCityId, cat.id);
  }

  if (sess.step === 'taxi_to_point') {
    const pts = mapPointsByCityAndCat(sess.data.toCityId, sess.data.toCatId);
    const pt = pts.find(p => p.name === text);
    if (!pt) return send3(vkId, 'Точка не найдена.');
    sess.data.toPointId = pt.id; sess.data.toName = pt.name; sess.data.toLat = pt.lat; sess.data.toLng = pt.lng;

    // Рассчитать стоимость
    const dist = haversine(sess.data.fromLat, sess.data.fromLng, sess.data.toLat, sess.data.toLng);
    const price = calcTaxiPrice(dist);
    sess.data.distKm = dist; sess.data.basePrice = price;
    sess.step = 'taxi_promo';
    clientSessionsG3.set(vkId, sess);
    const paxTxt = sess.data.passengers.length ? `\nПопутчики: ${sess.data.passengers.join(', ')}` : '';
    if (sess.msgId) await edit3(vkId, sess.msgId, `Маршрут:\nОткуда: ${sess.data.fromName}\nКуда: ${sess.data.toName}${paxTxt}\nРасстояние: ${dist.toFixed(1)} км\nСтоимость: ${price}р.\n\nЕсть промокод? Введите или пропустите:`, { keyboard: kb([[{ action:{ type:'text', label:'Пропустить' } }]], false) });
    else {
      const msgId = await send3(vkId, `Маршрут:\nОткуда: ${sess.data.fromName}\nКуда: ${sess.data.toName}${paxTxt}\nРасстояние: ${dist.toFixed(1)} км\nСтоимость: ${price}р.\n\nЕсть промокод? Введите или пропустите:`, { keyboard: kb([[{ action:{ type:'text', label:'Пропустить' } }]], false) });
      if (msgId) { sess.msgId = msgId; clientSessionsG3.set(vkId, sess); }
    }
    return;
  }

  if (sess.step === 'taxi_promo') {
    let discount = 0;
    let promoCode = null; let promoId = null;
    if (text !== 'Пропустить') {
      const promo = promoGet(text.trim().toUpperCase(), 'taxi');
      if (promo) { discount = applyTaxiPromo(promo, sess.data.basePrice); promoCode = promo.code; promoId = promo.id; }
      else if (sess.msgId) await edit3(vkId, sess.msgId, 'Промокод не найден. Продолжаем без скидки.');
    }
    sess.data.discount = discount; sess.data.promoCode = promoCode; sess.data.promoId = promoId;
    const finalPrice = sess.data.basePrice - discount;
    sess.data.finalPrice = finalPrice;
    sess.step = 'taxi_payment';
    clientSessionsG3.set(vkId, sess);
    const bankComm  = parseInt(getSetting('bank_commission_pct')||'5');
    const phoneComm = parseInt(getSetting('phone_commission_pct')||'7');
    if (sess.msgId) await edit3(vkId, sess.msgId, `Итоговая стоимость: ${finalPrice}р.${discount?` (скидка ${discount}р.)`:''}${promoCode?` [${promoCode}]`:''}\n\nСпособ оплаты:\n— Наличными (без комиссии)\n— Банк. счёт (комиссия ${bankComm}%)\n— Телефон (комиссия ${phoneComm}%)`,
      { keyboard: kb([[{ action:{ type:'text', label:'Наличными' } },{ action:{ type:'text', label:'Банковский счёт' } },{ action:{ type:'text', label:'Телефон' } }]], false) }
    );
    return;
  }

  if (sess.step === 'taxi_payment') {
    if (text === 'Наличными') {
      await finalizeTaxiOrder(vkId, sess, 'cash', sess.data.finalPrice);
      return;
    }
    if (text === 'Банковский счёт' || text === 'Телефон') {
      const isPhone = text === 'Телефон';
      const commPct = isPhone ? parseInt(getSetting('phone_commission_pct')||'7') : parseInt(getSetting('bank_commission_pct')||'5');
      const withComm = Math.round(sess.data.finalPrice * (1+commPct/100));
      const bankAcc = getSetting('bank_account')||'852006';
      sess.data.paymentType = isPhone ? 'phone' : 'bank';
      sess.data.withComm = withComm;
      sess.step = 'payment_proof';
      clientSessionsG3.set(vkId, sess);
      if (sess.msgId) await edit3(vkId, sess.msgId, `Переведите ${withComm}р. (с комиссией ${commPct}%) на счёт ${bankAcc}.\n\nПришлите скриншот оплаты:`);
      return;
    }
    return;
  }
}

async function sendTaxiCities(vkId, sess, which) {
  const cities = mapCityAll();
  if (!cities.length) { await send3(vkId, 'Города ещё не добавлены.'); return; }
  const rows = cities.map(c => [{ action:{ type:'text', label:c.name } }]);
  rows.push([{ action:{ type:'text', label:'Назад' } }]);
  const txt = which === 'from' ? 'Выберите город отправления:' : 'Выберите город назначения:';
  if (sess.msgId) await edit3(vkId, sess.msgId, txt, { keyboard: kb(rows, false) });
  else { const msgId = await send3(vkId, txt, { keyboard: kb(rows, false) }); if (msgId) { sess.msgId = msgId; clientSessionsG3.set(vkId, sess); } }
}

async function sendTaxiCats(vkId, sess, which, cityId) {
  const cats = mapCatAll();
  const rows = cats.map(c => [{ action:{ type:'text', label:c.name } }]);
  rows.push([{ action:{ type:'text', label:'Назад' } }]);
  const txt = which === 'from' ? 'Выберите категорию места отправления:' : 'Выберите категорию места назначения:';
  if (sess.msgId) await edit3(vkId, sess.msgId, txt, { keyboard: kb(rows, false) });
}

async function sendTaxiPoints(vkId, sess, which, cityId, catId) {
  const pts = mapPointsByCityAndCat(cityId, catId);
  if (!pts.length) { await send3(vkId, 'Точек не найдено.'); return; }
  const rows = pts.map(p => [{ action:{ type:'text', label:p.name } }]);
  rows.push([{ action:{ type:'text', label:'Назад' } }]);
  const txt = which === 'from' ? 'Выберите место отправления:' : 'Выберите место назначения:';
  if (sess.msgId) await edit3(vkId, sess.msgId, txt, { keyboard: kb(rows, false) });
}

async function finalizeTaxiOrder(vkId, sess, paymentType, finalPrice) {
  const taxiId = taxiCreate({ client_vk_id:vkId, client_nick:sess.data.nick, passengers:sess.data.passengers, from_point_id:sess.data.fromPointId, to_point_id:sess.data.toPointId, from_name:sess.data.fromName, to_name:sess.data.toName, distance_km:sess.data.distKm, payment_type:paymentType, total_price:finalPrice, promo_code:sess.data.promoCode||null, discount_amt:sess.data.discount||0 });
  if (sess.data.promoId) promoUse(sess.data.promoId);
  taxiUpdate(taxiId, { cart_msg_id: sess.msgId });
  sess.data.taxiId = taxiId;
  clientSessionsG3.set(vkId, sess);
  if (sess.msgId) await edit3(vkId, sess.msgId, 'Заказ оформлен! Ожидайте водителя.');
  await dispatchTaxiOrder(taxiId);
  clientSessionsG3.delete(vkId);
}

async function dispatchTaxiOrder(taxiId) {
  const order = taxiGet(taxiId);
  const paxTxt = JSON.parse(order.passengers||'[]').length ? `\nПопутчики: ${JSON.parse(order.passengers).join(', ')}` : '';
  const dispTxt = `[ЗАКАЗ ТАКСИ #${taxiId}]\nНик: ${order.client_nick}${paxTxt}\nОткуда: ${order.from_name}\nКуда: ${order.to_name}\nРасстояние: ${order.distance_km.toFixed(1)} км\nСумма: ${order.total_price}р. (${order.payment_type==='cash'?'наличные':order.payment_type==='phone'?'телефон':'банк'})`;

  const drivers = getOnlineCouriers('taxi');
  if (!drivers.length) {
    await send3(order.client_vk_id, 'К сожалению, сейчас нет водителей в сети. Попробуйте позже.');
    taxiUpdate(taxiId, { status:'cancelled' });
    return;
  }

  const dispPeer = CHATS.dispetcherskaya_taxi || CHATS.dispetcherskaya;
  const dispKb   = JSON.stringify({ inline:true, buttons:[[{ action:{ type:'callback', label:'Принять поездку', payload:JSON.stringify({ action:'accept_taxi', taxiId }) }, color:'positive' }]] });
  const msgId = await send1(dispPeer, dispTxt, { keyboard: dispKb });
  if (msgId) taxiUpdate(taxiId, { dispatch_msg_id: msgId });

  await notifyCouriers(dispPeer, drivers.map(d=>d.vk_id));

  setTimeout(async () => {
    const o = taxiGet(taxiId);
    if (o && o.status === 'pending') {
      const onlineList = drivers.map(d=>`${d.nick} (${roleDisplayShort(d.role||'kurier')})`).join('\n');
      const ssPeer = CHATS.ss_taxi||CHATS.ss;
      await send1(ssPeer, `[ТАКСИ #${taxiId} НЕ ПРИНЯТО 3 МИН]\nВодители в сети:\n${onlineList}`);
      await notifyCouriers(dispPeer, drivers.map(d=>d.vk_id));
    }
  }, 3*60*1000);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ОТЧЁТЫ (ежедневные и еженедельные в 18:00)
// ═══════════════════════════════════════════════════════════════════════════════

function buildDailyReport(org) {
  const d = dateMSK().split(' ')[0];
  const stat = statsGetToday(org);
  if (!stat || !stat.orders_count) return `Отчёт за ${d} (${org}): Заказов нет.`;

  const salaryPct        = parseFloat(getSetting('salary_pct')||'15') / 100;
  const salaryColoredPct = parseFloat(getSetting('salary_colored_pct')||'10') / 100;
  const orgPct           = parseFloat(getSetting('income_org_pct')||'5') / 100;

  // Выплаты по курьерам: берём выполненные заказы за сегодня
  const doneOrders = q(`SELECT o.*, s.nick, s.bank_acc FROM orders o LEFT JOIN staff s ON o.courier_vk_id=s.vk_id WHERE o.status='done' AND date(o.updated_at/1000, 'unixepoch')=? AND o.courier_vk_id IS NOT NULL`).all(d);

  const payouts = {};
  for (const o of doneOrders) {
    const isColored = (() => { const veh = vehicleGetAll(o.courier_vk_id); return veh.some(v => v.is_colored||v.is_org); })();
    const pct = isColored ? salaryColoredPct : salaryPct;
    const salary = Math.round(o.total_price * pct - o.total_cost * orgPct);
    if (!payouts[o.courier_vk_id]) payouts[o.courier_vk_id] = { nick: o.nick||`ID${o.courier_vk_id}`, bank: o.bank_acc||'?', salary:0 };
    payouts[o.courier_vk_id].salary += salary;
  }

  let txt = `Ежедневный отчёт [${org}] — ${d}\n\nЗаказов: ${stat.orders_count}\nВыручка: ${stat.total_revenue}р.\n\nВыплаты курьерам:\n`;
  for (const [id, p] of Object.entries(payouts)) {
    txt += `${p.nick} (${p.bank}): ${p.salary}р.\n`;
  }
  return txt;
}

function buildWeeklyReport(org) {
  const now = dateMSK();
  const d   = now.split(' ')[0];
  const weekStart = new Date(Date.now() - 6*86400000);
  const ws = dateMSK(weekStart).split(' ')[0];
  const stats = statsGetRange(ws, d, org);

  const salaryPct        = parseFloat(getSetting('salary_pct')||'15') / 100;
  const salaryColoredPct = parseFloat(getSetting('salary_colored_pct')||'10') / 100;
  const orgPct           = parseFloat(getSetting('income_org_pct')||'5') / 100;

  const totalOrders = stats.reduce((s,r)=>s+r.orders_count,0);
  const totalRev    = stats.reduce((s,r)=>s+r.total_revenue,0);
  const totalCost   = stats.reduce((s,r)=>s+r.total_cost,0);

  const doneOrders = q(`SELECT o.*, s.nick, s.bank_acc FROM orders o LEFT JOIN staff s ON o.courier_vk_id=s.vk_id WHERE o.status='done' AND date(o.updated_at/1000,'unixepoch')>=? AND date(o.updated_at/1000,'unixepoch')<=? AND o.courier_vk_id IS NOT NULL`).all(ws, d);

  const payouts = {};
  for (const o of doneOrders) {
    const isColored = vehicleGetAll(o.courier_vk_id).some(v=>v.is_colored||v.is_org);
    const pct = isColored ? salaryColoredPct : salaryPct;
    const salary = Math.round(o.total_price * pct - o.total_cost * orgPct);
    if (!payouts[o.courier_vk_id]) payouts[o.courier_vk_id] = { nick:o.nick||`ID${o.courier_vk_id}`, bank:o.bank_acc||'?', salary:0 };
    payouts[o.courier_vk_id].salary += salary;
  }

  const totalPayout = Object.values(payouts).reduce((s,p)=>s+p.salary,0);
  const income = totalRev * 0.15 - (totalCost + totalPayout) * orgPct;

  let txt = `Еженедельный отчёт [${org}] — ${ws} — ${d}\n\nЗаказов за неделю: ${totalOrders}\nВыручка: ${totalRev}р.\n\nЗарплаты:\n`;
  for (const [id, p] of Object.entries(payouts)) txt += `${p.nick} (${p.bank}): ${p.salary}р.\n`;
  txt += `\nДоход организации за неделю: ${Math.round(income)}р.`;
  return txt;
}

async function sendDailyReport() {
  for (const org of ['delivery','taxi']) {
    const txt = buildDailyReport(org);
    const kbReport = JSON.stringify({ inline:true, buttons:[[{ action:{ type:'callback', label:'Обработано', payload:JSON.stringify({ action:'report_done' }) }, color:'positive' }]] });
    await send1(CHATS.rukovodstvo, `[${fmtDate()}] ${txt}`, { keyboard: kbReport });
  }
}

async function sendWeeklyReport() {
  for (const org of ['delivery','taxi']) {
    const daily  = buildDailyReport(org);
    const weekly = buildWeeklyReport(org);
    const kbReport = JSON.stringify({ inline:true, buttons:[[{ action:{ type:'callback', label:'Обработано', payload:JSON.stringify({ action:'report_done' }) }, color:'positive' }]] });
    await send1(CHATS.rukovodstvo, `[${fmtDate()}]\n${daily}\n\n${weekly}`, { keyboard: kbReport });
  }
}

// Планировщик отчётов
function startReportScheduler() {
  function msUntil(hour, min=0) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone:'Europe/Moscow' }));
    const target = new Date(now); target.setHours(hour, min, 0, 0);
    let ms = target - now; if (ms < 0) ms += 86400000;
    return ms;
  }

  function scheduleDaily() {
    const ms = msUntil(18, 0);
    setTimeout(async () => {
      const msk = new Date(new Date().toLocaleString('en-US', { timeZone:'Europe/Moscow' }));
      if (msk.getDay() === 0) await sendWeeklyReport();
      else await sendDailyReport();
      scheduleDaily();
    }, ms);
  }
  scheduleDaily();
  console.log('[Reports] Планировщик запущен (18:00 МСК ежедневно)');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LONG POLLING (три параллельных цикла)
// ═══════════════════════════════════════════════════════════════════════════════

async function runLongPoll(groupId, token, handler, label) {
  while (true) {
    try {
      let server = await getLongPollServer(groupId, token);
      let ts = server.ts;
      console.log(`[${label}] Long Poll запущен`);

      while (true) {
        try {
          const url  = `${server.server}?act=a_check&key=${server.key}&ts=${ts}&wait=25`;
          const data = await (await fetch(url)).json();

          if (data.failed) {
            if (data.failed === 1) { ts = data.ts; continue; }
            server = await getLongPollServer(groupId, token);
            ts = server.ts;
            continue;
          }

          ts = data.ts;
          if (data.updates?.length) {
            for (const upd of data.updates) {
              handler(upd).catch(e => console.error(`[${label}] handler error:`, e.message));
            }
          }
        } catch(e) {
          console.error(`[${label}] poll error:`, e.message);
          await new Promise(r => setTimeout(r, 3000));
          try { server = await getLongPollServer(groupId, token); ts = server.ts; } catch {}
        }
      }
    } catch(e) {
      console.error(`[${label}] outer error:`, e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ЗАПУСК
// ═══════════════════════════════════════════════════════════════════════════════

process.on('SIGINT',  () => { console.log('\n[Bot] Остановка...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n[Bot] Остановка...'); process.exit(0); });

console.log('[Bot] Запуск трёх Long Poll циклов...');

// Запускаем всё параллельно
Promise.all([
  G1_TOKEN && G1_ID ? runLongPoll(G1_ID, G1_TOKEN, handleG1Event, 'G1') : Promise.resolve(),
  G2_TOKEN && G2_ID ? runLongPoll(G2_ID, G2_TOKEN, handleG2Event, 'G2') : Promise.resolve(),
  G3_TOKEN && G3_ID ? runLongPoll(G3_ID, G3_TOKEN, handleG3Event, 'G3') : Promise.resolve(),
]).catch(e => { console.error('[Bot] Критическая ошибка:', e); process.exit(1); });

startReportScheduler();
