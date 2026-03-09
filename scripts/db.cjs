/**
 * db.cjs — SQLite база данных для VK бота
 * Использует better-sqlite3 (синхронный API, идеально для однопоточного Node.js)
 *
 * Таблицы:
 *  - staff           профили сотрудников
 *  - vehicles        автопарк (личный + организации)
 *  - categories      категории товаров
 *  - products        товары
 *  - sets            сеты (комплекты товаров)
 *  - set_items       состав сетов
 *  - orders          заказы (доставка)
 *  - order_items     товары в заказе
 *  - taxi_orders     заказы такси
 *  - promos          промокоды (доставка + такси)
 *  - activity_log    журнал активности (!онлайн/!афк/!вышел)
 *  - daily_stats     ежедневная статистика заказов
 *  - blacklist       локальный ЧС (мигрировано из JSON)
 *  - mutes           муты (мигрировано из JSON)
 *  - settings        ключ-значение настройки (тариф такси и тп)
 *  - map_cities      города для такси
 *  - map_categories  категории точек карты
 *  - map_points      точки карты такси
 *  - org_vehicles    автомобили организации
 */

const path = require('path');
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('[DB] better-sqlite3 не установлен! Запустите: npm install better-sqlite3');
  process.exit(1);
}

const DB_PATH = path.join(__dirname, 'bot.db');
const db = new Database(DB_PATH);

// WAL режим для лучшей производительности
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============= СОЗДАНИЕ ТАБЛИЦ =============

db.exec(`
  CREATE TABLE IF NOT EXISTS staff (
    vk_id       INTEGER PRIMARY KEY,
    nick        TEXT NOT NULL,
    bank_acc    TEXT,
    role        TEXT DEFAULT 'kurier',   -- rs / ss / kurier / stazher
    org_flags   TEXT DEFAULT '{}',       -- JSON: { delivery: bool, taxi: bool }
    registered_at INTEGER DEFAULT (strftime('%s','now') * 1000),
    orders_done INTEGER DEFAULT 0,
    orders_week INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS org_vehicles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    photo_url   TEXT,
    added_by    INTEGER,
    added_at    INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS vehicles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vk_id       INTEGER NOT NULL,
    name        TEXT NOT NULL,
    photo_url   TEXT,
    is_org      INTEGER DEFAULT 0,   -- 1 = авто организации, 0 = личное
    is_colored  INTEGER DEFAULT 0,   -- 1 = в цветах организации (15%→10%)
    org_vehicle_id INTEGER,          -- ссылка на org_vehicles если is_org=1
    FOREIGN KEY(vk_id) REFERENCES staff(vk_id)
  );

  CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    parent_id   INTEGER DEFAULT NULL  -- NULL = корневая категория
  );

  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    name        TEXT NOT NULL,
    price       INTEGER NOT NULL,     -- стоимость для клиента (руб)
    cost        INTEGER NOT NULL,     -- себестоимость для отчётов
    photo_url   TEXT,
    instruction_photo TEXT,           -- фото-инструкция для курьера
    simple_items TEXT DEFAULT '[]',   -- JSON: [{ name, qty }] простые составляющие
    is_set      INTEGER DEFAULT 0,
    FOREIGN KEY(category_id) REFERENCES categories(id)
  );

  CREATE TABLE IF NOT EXISTS sets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    price       INTEGER NOT NULL,
    cost        INTEGER NOT NULL,
    photo_url   TEXT
  );

  CREATE TABLE IF NOT EXISTS set_items (
    set_id      INTEGER NOT NULL,
    product_id  INTEGER,
    name        TEXT,                 -- если простой товар без product_id
    qty         INTEGER DEFAULT 1,
    FOREIGN KEY(set_id) REFERENCES sets(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_vk_id  INTEGER NOT NULL,
    client_nick   TEXT NOT NULL,
    location      TEXT NOT NULL,
    status        TEXT DEFAULT 'pending',
    -- pending / accepted / preparing / delivering / arrived / done / cancelled
    courier_vk_id INTEGER DEFAULT NULL,
    courier_nick  TEXT DEFAULT NULL,
    eta_minutes   INTEGER DEFAULT NULL,
    payment_type  TEXT DEFAULT 'cash',    -- cash / bank
    payment_proof TEXT DEFAULT NULL,       -- ссылка на скрин оплаты
    promo_code    TEXT DEFAULT NULL,
    discount_amt  INTEGER DEFAULT 0,       -- скидка в рублях
    total_price   INTEGER NOT NULL,
    total_cost    INTEGER NOT NULL,
    dispatch_msg_id INTEGER DEFAULT NULL,  -- conversation_message_id в диспетчерской
    cart_msg_id     INTEGER DEFAULT NULL,  -- conversation_message_id корзины у клиента
    helper_msg_id   INTEGER DEFAULT NULL,  -- conversation_message_id помощника курьера
    created_at    INTEGER DEFAULT (strftime('%s','now') * 1000),
    updated_at    INTEGER DEFAULT (strftime('%s','now') * 1000),
    org           TEXT DEFAULT 'delivery'  -- delivery / taxi
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    INTEGER NOT NULL,
    product_id  INTEGER,
    set_id      INTEGER,
    name        TEXT NOT NULL,
    price       INTEGER NOT NULL,
    cost        INTEGER NOT NULL,
    qty         INTEGER DEFAULT 1,
    bought      INTEGER DEFAULT 0,   -- 1 = куплено курьером (для помощника)
    FOREIGN KEY(order_id) REFERENCES orders(id)
  );

  CREATE TABLE IF NOT EXISTS taxi_orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    client_vk_id    INTEGER NOT NULL,
    client_nick     TEXT NOT NULL,
    passengers      TEXT DEFAULT '[]',   -- JSON: [nick1, nick2]
    from_point_id   INTEGER NOT NULL,
    to_point_id     INTEGER NOT NULL,
    from_name       TEXT NOT NULL,
    to_name         TEXT NOT NULL,
    distance_km     REAL DEFAULT 0,
    payment_type    TEXT DEFAULT 'cash',  -- cash / phone / bank
    payment_proof   TEXT DEFAULT NULL,
    promo_code      TEXT DEFAULT NULL,
    discount_amt    INTEGER DEFAULT 0,
    total_price     INTEGER NOT NULL,
    status          TEXT DEFAULT 'pending',
    -- pending / accepted / waiting / driving / arrived / done / cancelled
    driver_vk_id    INTEGER DEFAULT NULL,
    driver_nick     TEXT DEFAULT NULL,
    paid_waiting    INTEGER DEFAULT 0,   -- платное ожидание (мин)
    dispatch_msg_id INTEGER DEFAULT NULL,
    cart_msg_id     INTEGER DEFAULT NULL,
    created_at      INTEGER DEFAULT (strftime('%s','now') * 1000),
    updated_at      INTEGER DEFAULT (strftime('%s','now') * 1000),
    FOREIGN KEY(from_point_id) REFERENCES map_points(id),
    FOREIGN KEY(to_point_id)   REFERENCES map_points(id)
  );

  CREATE TABLE IF NOT EXISTS promos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    org         TEXT NOT NULL,   -- delivery / taxi
    type        TEXT NOT NULL,
    -- delivery: discount_pct / discount_abs / free_product / free_category /
    --           discount_product_pct / discount_product_abs
    -- taxi:     discount_pct / discount_abs / free_ride
    value       INTEGER DEFAULT 0,      -- процент или рублей
    product_id  INTEGER DEFAULT NULL,   -- для free_product / discount_product_*
    category_id INTEGER DEFAULT NULL,   -- для free_category
    uses_left   INTEGER DEFAULT -1,     -- -1 = безлимит
    expires_at  INTEGER DEFAULT NULL,
    created_by  INTEGER,
    created_at  INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vk_id       INTEGER NOT NULL,
    nick        TEXT NOT NULL,
    role        TEXT,
    status      TEXT DEFAULT 'online',   -- online / afk / offline
    status_text TEXT DEFAULT '',
    org_flags   TEXT DEFAULT '{}',       -- какая орг (delivery/taxi)
    changed_at  INTEGER DEFAULT (strftime('%s','now') * 1000),
    msg_id      INTEGER DEFAULT NULL     -- conversation_message_id последнего сообщения ЖА
  );

  CREATE TABLE IF NOT EXISTS online_sessions (
    vk_id       INTEGER PRIMARY KEY,
    nick        TEXT NOT NULL,
    role        TEXT,
    status      TEXT DEFAULT 'online',
    status_text TEXT DEFAULT '',
    org_flags   TEXT DEFAULT '{}',
    started_at  INTEGER DEFAULT (strftime('%s','now') * 1000),
    last_msg_id INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_stats (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    date_str      TEXT NOT NULL,   -- YYYY-MM-DD
    org           TEXT NOT NULL,   -- delivery / taxi
    orders_count  INTEGER DEFAULT 0,
    total_revenue INTEGER DEFAULT 0,
    total_cost    INTEGER DEFAULT 0,
    reported      INTEGER DEFAULT 0,   -- 1 = отчёт уже отправлен
    UNIQUE(date_str, org)
  );

  CREATE TABLE IF NOT EXISTS blacklist (
    vk_id       INTEGER PRIMARY KEY,
    end_date    INTEGER DEFAULT 0,   -- 0 = перманент
    reason      TEXT DEFAULT 'Нарушение правил',
    banned_at   INTEGER DEFAULT (strftime('%s','now') * 1000),
    banned_by   INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS mutes (
    vk_id       INTEGER PRIMARY KEY,
    end_date    INTEGER NOT NULL,
    reason      TEXT DEFAULT 'Нарушение правил',
    muted_at    INTEGER DEFAULT (strftime('%s','now') * 1000),
    muted_by    INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS map_cities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS map_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE
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

  -- Дефолтная категория "Сеты"
  INSERT OR IGNORE INTO categories(id, name) VALUES(1, 'Сеты');

  -- Дефолтные настройки
  INSERT OR IGNORE INTO settings(key, value) VALUES('taxi_rate_per_km', '50');
  INSERT OR IGNORE INTO settings(key, value) VALUES('taxi_peak_multiplier', '1.5');
  INSERT OR IGNORE INTO settings(key, value) VALUES('taxi_peak_hours', '[[8,10],[17,20]]');
  INSERT OR IGNORE INTO settings(key, value) VALUES('bank_account', '852006');
  INSERT OR IGNORE INTO settings(key, value) VALUES('bank_commission_pct', '5');
  INSERT OR IGNORE INTO settings(key, value) VALUES('phone_commission_pct', '7');
  INSERT OR IGNORE INTO settings(key, value) VALUES('taxi_waiting_rate_per_min', '10');
`);

console.log('[DB] База данных инициализирована:', DB_PATH);

// ============= ХЕЛПЕРЫ =============

// --- НАСТРОЙКИ ---
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES(?, ?, ?)').run(key, String(value), Date.now());
}

// --- BLACKLIST (совместимость с JSON-логикой) ---
function blAddUser(vkId, days, reason, bannedBy) {
  const endDate = (days === 0 || days === 999) ? 0 : Date.now() + days * 86400000;
  db.prepare('INSERT OR REPLACE INTO blacklist(vk_id, end_date, reason, banned_at, banned_by) VALUES(?,?,?,?,?)')
    .run(vkId, endDate, reason, Date.now(), bannedBy || null);
}
function blRemoveUser(vkId) {
  const info = db.prepare('DELETE FROM blacklist WHERE vk_id = ?').run(vkId);
  return info.changes > 0;
}
function blGetUser(vkId) {
  const row = db.prepare('SELECT * FROM blacklist WHERE vk_id = ?').get(vkId);
  if (!row) return null;
  if (row.end_date !== 0 && row.end_date < Date.now()) {
    blRemoveUser(vkId);
    return null;
  }
  return row;
}
function blGetAll() {
  const now = Date.now();
  return db.prepare('SELECT * FROM blacklist WHERE end_date = 0 OR end_date > ?').all(now);
}

// --- MUTES ---
function muteAdd(vkId, minutes, reason, mutedBy) {
  const endDate = Date.now() + minutes * 60000;
  db.prepare('INSERT OR REPLACE INTO mutes(vk_id, end_date, reason, muted_at, muted_by) VALUES(?,?,?,?,?)')
    .run(vkId, endDate, reason, Date.now(), mutedBy || null);
}
function muteRemove(vkId) {
  const info = db.prepare('DELETE FROM mutes WHERE vk_id = ?').run(vkId);
  return info.changes > 0;
}
function muteGet(vkId) {
  const row = db.prepare('SELECT * FROM mutes WHERE vk_id = ?').get(vkId);
  if (!row) return null;
  if (row.end_date < Date.now()) {
    muteRemove(vkId);
    return null;
  }
  return row;
}

// --- STAFF ---
function staffGet(vkId) {
  return db.prepare('SELECT * FROM staff WHERE vk_id = ?').get(vkId);
}
function staffCreate(vkId, nick, bankAcc) {
  db.prepare('INSERT OR IGNORE INTO staff(vk_id, nick, bank_acc) VALUES(?,?,?)').run(vkId, nick, bankAcc || null);
}
function staffUpdate(vkId, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE staff SET ${sets} WHERE vk_id = ?`).run(...keys.map(k => fields[k]), vkId);
}
function staffGetAll() {
  return db.prepare('SELECT * FROM staff').all();
}

// --- VEHICLES ---
function vehicleAdd(vkId, name, photoUrl, isOrg, isColored, orgVehicleId) {
  const info = db.prepare('INSERT INTO vehicles(vk_id, name, photo_url, is_org, is_colored, org_vehicle_id) VALUES(?,?,?,?,?,?)')
    .run(vkId, name, photoUrl || null, isOrg ? 1 : 0, isColored ? 1 : 0, orgVehicleId || null);
  return info.lastInsertRowid;
}
function vehicleGetAll(vkId) {
  return db.prepare('SELECT * FROM vehicles WHERE vk_id = ?').all(vkId);
}
function vehicleRemove(id) {
  db.prepare('DELETE FROM vehicles WHERE id = ?').run(id);
}
function orgVehicleAdd(name, photoUrl, addedBy) {
  const info = db.prepare('INSERT INTO org_vehicles(name, photo_url, added_by) VALUES(?,?,?)').run(name, photoUrl || null, addedBy || null);
  return info.lastInsertRowid;
}
function orgVehicleGetAll() {
  return db.prepare('SELECT * FROM org_vehicles').all();
}
function orgVehicleGet(id) {
  return db.prepare('SELECT * FROM org_vehicles WHERE id = ?').get(id);
}

// --- CATEGORIES ---
function categoryGetAll() {
  return db.prepare('SELECT * FROM categories').all();
}
function categoryGet(id) {
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
}
function categoryAdd(name, parentId) {
  const info = db.prepare('INSERT INTO categories(name, parent_id) VALUES(?,?)').run(name, parentId || null);
  return info.lastInsertRowid;
}
function categoryRemove(id) {
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
}

// --- PRODUCTS ---
function productGetAll(categoryId) {
  if (categoryId !== undefined) {
    return db.prepare('SELECT * FROM products WHERE category_id = ?').all(categoryId);
  }
  return db.prepare('SELECT * FROM products').all();
}
function productGet(id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}
function productAdd({ categoryId, name, price, cost, photoUrl, instructionPhoto, simpleItems }) {
  const info = db.prepare('INSERT INTO products(category_id, name, price, cost, photo_url, instruction_photo, simple_items) VALUES(?,?,?,?,?,?,?)')
    .run(categoryId, name, price, cost, photoUrl || null, instructionPhoto || null, JSON.stringify(simpleItems || []));
  return info.lastInsertRowid;
}
function productUpdate(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE products SET ${sets} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
}
function productRemove(id) {
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
}

// --- SETS ---
function setGetAll() {
  return db.prepare('SELECT * FROM sets').all();
}
function setGet(id) {
  return db.prepare('SELECT * FROM sets WHERE id = ?').get(id);
}
function setItems(setId) {
  return db.prepare('SELECT * FROM set_items WHERE set_id = ?').all(setId);
}
function setAdd({ name, price, cost, photoUrl, items }) {
  const info = db.prepare('INSERT INTO sets(name, price, cost, photo_url) VALUES(?,?,?,?)').run(name, price, cost, photoUrl || null);
  const setId = info.lastInsertRowid;
  const stmt = db.prepare('INSERT INTO set_items(set_id, product_id, name, qty) VALUES(?,?,?,?)');
  for (const item of (items || [])) {
    stmt.run(setId, item.product_id || null, item.name || null, item.qty || 1);
  }
  return setId;
}
function setRemove(id) {
  db.prepare('DELETE FROM set_items WHERE set_id = ?').run(id);
  db.prepare('DELETE FROM sets WHERE id = ?').run(id);
}

// --- ORDERS ---
function orderCreate(data) {
  const info = db.prepare(`
    INSERT INTO orders(client_vk_id, client_nick, location, payment_type, promo_code, discount_amt, total_price, total_cost, cart_msg_id, org)
    VALUES(@client_vk_id, @client_nick, @location, @payment_type, @promo_code, @discount_amt, @total_price, @total_cost, @cart_msg_id, @org)
  `).run(data);
  return info.lastInsertRowid;
}
function orderAddItem(orderId, item) {
  db.prepare('INSERT INTO order_items(order_id, product_id, set_id, name, price, cost, qty) VALUES(?,?,?,?,?,?,?)')
    .run(orderId, item.product_id || null, item.set_id || null, item.name, item.price, item.cost, item.qty || 1);
}
function orderGet(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}
function orderGetItems(orderId) {
  return db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
}
function orderUpdate(id, fields) {
  fields.updated_at = Date.now();
  const keys = Object.keys(fields);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE orders SET ${sets} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
}
function orderItemSetBought(itemId, bought) {
  db.prepare('UPDATE order_items SET bought = ? WHERE id = ?').run(bought ? 1 : 0, itemId);
}
function orderGetByClient(clientVkId, status) {
  if (status) {
    return db.prepare('SELECT * FROM orders WHERE client_vk_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1').get(clientVkId, status);
  }
  return db.prepare("SELECT * FROM orders WHERE client_vk_id = ? AND status NOT IN ('done','cancelled') ORDER BY created_at DESC LIMIT 1").get(clientVkId);
}
function orderGetByCourier(courierVkId) {
  return db.prepare("SELECT * FROM orders WHERE courier_vk_id = ? AND status NOT IN ('done','cancelled') ORDER BY created_at DESC LIMIT 1").get(courierVkId);
}
// Статистика за день для отчётов
function orderGetDailyStats(dateStr, org) {
  return db.prepare("SELECT COUNT(*) as cnt, SUM(total_price) as revenue, SUM(total_cost) as cost FROM orders WHERE date(created_at/1000,'unixepoch') = ? AND org = ? AND status = 'done'").get(dateStr, org);
}

// --- TAXI ORDERS ---
function taxiCreate(data) {
  const info = db.prepare(`
    INSERT INTO taxi_orders(client_vk_id, client_nick, passengers, from_point_id, to_point_id, from_name, to_name, distance_km, payment_type, promo_code, discount_amt, total_price, cart_msg_id)
    VALUES(@client_vk_id, @client_nick, @passengers, @from_point_id, @to_point_id, @from_name, @to_name, @distance_km, @payment_type, @promo_code, @discount_amt, @total_price, @cart_msg_id)
  `).run(data);
  return info.lastInsertRowid;
}
function taxiGet(id) {
  return db.prepare('SELECT * FROM taxi_orders WHERE id = ?').get(id);
}
function taxiUpdate(id, fields) {
  fields.updated_at = Date.now();
  const keys = Object.keys(fields);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE taxi_orders SET ${sets} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
}
function taxiGetByClient(clientVkId) {
  return db.prepare("SELECT * FROM taxi_orders WHERE client_vk_id = ? AND status NOT IN ('done','cancelled') ORDER BY created_at DESC LIMIT 1").get(clientVkId);
}
function taxiGetByDriver(driverVkId) {
  return db.prepare("SELECT * FROM taxi_orders WHERE driver_vk_id = ? AND status NOT IN ('done','cancelled') ORDER BY created_at DESC LIMIT 1").get(driverVkId);
}

// --- PROMOS ---
function promoGet(code) {
  const row = db.prepare('SELECT * FROM promos WHERE code = ?').get(code);
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) return null;
  if (row.uses_left === 0) return null;
  return row;
}
function promoUse(code) {
  db.prepare('UPDATE promos SET uses_left = uses_left - 1 WHERE code = ? AND uses_left > 0').run(code);
}
function promoAdd(data) {
  const info = db.prepare('INSERT INTO promos(code, org, type, value, product_id, category_id, uses_left, expires_at, created_by) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(data.code, data.org, data.type, data.value || 0, data.product_id || null, data.category_id || null, data.uses_left ?? -1, data.expires_at || null, data.created_by || null);
  return info.lastInsertRowid;
}
function promoRemove(code) {
  db.prepare('DELETE FROM promos WHERE code = ?').run(code);
}
function promoGetAll(org) {
  if (org) return db.prepare('SELECT * FROM promos WHERE org = ?').all(org);
  return db.prepare('SELECT * FROM promos').all();
}

// --- ACTIVITY LOG / ONLINE SESSIONS ---
function onlineSet(vkId, nick, role, status, statusText, orgFlags) {
  db.prepare('INSERT OR REPLACE INTO online_sessions(vk_id, nick, role, status, status_text, org_flags, started_at) VALUES(?,?,?,?,?,?,?)')
    .run(vkId, nick, role, status, statusText, JSON.stringify(orgFlags || {}), Date.now());
}
function onlineRemove(vkId) {
  db.prepare('DELETE FROM online_sessions WHERE vk_id = ?').run(vkId);
}
function onlineGet(vkId) {
  return db.prepare('SELECT * FROM online_sessions WHERE vk_id = ?').get(vkId);
}
function onlineGetAll() {
  return db.prepare('SELECT * FROM online_sessions ORDER BY started_at ASC').all();
}
function onlineSetMsgId(vkId, msgId) {
  db.prepare('UPDATE online_sessions SET last_msg_id = ? WHERE vk_id = ?').run(msgId, vkId);
}
function activityLogAdd(vkId, nick, role, status, statusText, orgFlags) {
  db.prepare('INSERT INTO activity_log(vk_id, nick, role, status, status_text, org_flags) VALUES(?,?,?,?,?,?)')
    .run(vkId, nick, role, status, statusText, JSON.stringify(orgFlags || {}));
}

// --- DAILY STATS ---
function dailyStatsIncrement(dateStr, org, priceDelta, costDelta) {
  db.prepare(`
    INSERT INTO daily_stats(date_str, org, orders_count, total_revenue, total_cost)
    VALUES(?,?,1,?,?)
    ON CONFLICT(date_str, org) DO UPDATE SET
      orders_count  = orders_count + 1,
      total_revenue = total_revenue + excluded.total_revenue,
      total_cost    = total_cost + excluded.total_cost
  `).run(dateStr, org, priceDelta, costDelta);
}
function dailyStatsGet(dateStr, org) {
  return db.prepare('SELECT * FROM daily_stats WHERE date_str = ? AND org = ?').get(dateStr, org);
}
function dailyStatsMarkReported(dateStr, org) {
  db.prepare("UPDATE daily_stats SET reported = 1 WHERE date_str = ? AND org = ?").run(dateStr, org);
}
function dailyStatsRange(fromDate, toDate, org) {
  return db.prepare('SELECT * FROM daily_stats WHERE date_str >= ? AND date_str <= ? AND org = ?').all(fromDate, toDate, org);
}

// --- MAP ---
function mapCityGetAll() {
  return db.prepare('SELECT * FROM map_cities').all();
}
function mapCityGet(id) {
  return db.prepare('SELECT * FROM map_cities WHERE id = ?').get(id);
}
function mapCityAdd(name) {
  const info = db.prepare('INSERT OR IGNORE INTO map_cities(name) VALUES(?)').run(name);
  return info.lastInsertRowid || db.prepare('SELECT id FROM map_cities WHERE name = ?').get(name).id;
}
function mapCategoryGetAll() {
  return db.prepare('SELECT * FROM map_categories').all();
}
function mapCategoryGet(id) {
  return db.prepare('SELECT * FROM map_categories WHERE id = ?').get(id);
}
function mapCategoryAdd(name) {
  const info = db.prepare('INSERT OR IGNORE INTO map_categories(name) VALUES(?)').run(name);
  return info.lastInsertRowid || db.prepare('SELECT id FROM map_categories WHERE name = ?').get(name).id;
}
function mapPointGetAll() {
  return db.prepare(`
    SELECT p.*, c.name as city_name, cat.name as category_name
    FROM map_points p
    LEFT JOIN map_cities c ON c.id = p.city_id
    LEFT JOIN map_categories cat ON cat.id = p.category_id
  `).all();
}
function mapPointGet(id) {
  return db.prepare(`
    SELECT p.*, c.name as city_name, cat.name as category_name
    FROM map_points p
    LEFT JOIN map_cities c ON c.id = p.city_id
    LEFT JOIN map_categories cat ON cat.id = p.category_id
    WHERE p.id = ?
  `).get(id);
}
function mapPointsByCity(cityId) {
  return db.prepare(`
    SELECT p.*, c.name as city_name, cat.name as category_name
    FROM map_points p
    LEFT JOIN map_cities c ON c.id = p.city_id
    LEFT JOIN map_categories cat ON cat.id = p.category_id
    WHERE p.city_id = ?
  `).all(cityId);
}
function mapPointsByCategory(cityId, categoryId) {
  return db.prepare(`
    SELECT p.*, c.name as city_name, cat.name as category_name
    FROM map_points p
    LEFT JOIN map_cities c ON c.id = p.city_id
    LEFT JOIN map_categories cat ON cat.id = p.category_id
    WHERE p.city_id = ? AND p.category_id = ?
  `).all(cityId, categoryId);
}
function mapPointAdd({ name, cityId, categoryId, lat, lng }) {
  const info = db.prepare('INSERT INTO map_points(name, city_id, category_id, lat, lng) VALUES(?,?,?,?,?)').run(name, cityId, categoryId, lat, lng);
  return info.lastInsertRowid;
}
function mapPointRemove(id) {
  db.prepare('DELETE FROM map_points WHERE id = ?').run(id);
}

// --- РАСЧЁТ РАССТОЯНИЯ (Haversine) ---
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function calcTaxiPrice(fromPointId, toPointId) {
  const from = mapPointGet(fromPointId);
  const to = mapPointGet(toPointId);
  if (!from || !to) return { price: 0, distance: 0 };
  const dist = haversineKm(from.lat, from.lng, to.lat, to.lng);
  const ratePerKm = parseFloat(getSetting('taxi_rate_per_km') || '50');
  const peakMultiplier = parseFloat(getSetting('taxi_peak_multiplier') || '1.5');
  const peakHours = JSON.parse(getSetting('taxi_peak_hours') || '[[8,10],[17,20]]');
  const hour = new Date().getHours();
  const isPeak = peakHours.some(([s, e]) => hour >= s && hour < e);
  const price = Math.ceil(dist * ratePerKm * (isPeak ? peakMultiplier : 1));
  return { price, distance: Math.round(dist * 10) / 10, isPeak };
}

// --- ПРИМЕНЕНИЕ ПРОМОКОДА ---
function applyPromo(code, org, cart) {
  // cart = { items: [{name, price, qty, product_id?}], total }
  const promo = promoGet(code);
  if (!promo) return { ok: false, msg: 'Промокод не найден или истёк' };
  if (promo.org !== org) return { ok: false, msg: 'Промокод не действует для этого сервиса' };
  let discount = 0;
  let freeItem = null;
  switch (promo.type) {
    case 'discount_pct':
      discount = Math.floor(cart.total * promo.value / 100);
      break;
    case 'discount_abs':
      discount = Math.min(promo.value, cart.total);
      break;
    case 'free_ride':
      discount = cart.total;
      break;
    case 'free_product':
      if (promo.product_id) {
        const prod = productGet(promo.product_id);
        if (prod) { freeItem = { ...prod, qty: 1, free: true }; discount = prod.price; }
      }
      break;
    case 'free_category':
      // Обрабатывается отдельно (клиент выбирает товар)
      return { ok: true, promo, discount: 0, freeCategory: promo.category_id };
    case 'discount_product_pct':
      if (promo.product_id) {
        const item = cart.items.find(i => i.product_id === promo.product_id);
        if (item) discount = Math.floor(item.price * item.qty * promo.value / 100);
      }
      break;
    case 'discount_product_abs':
      if (promo.product_id) {
        const item = cart.items.find(i => i.product_id === promo.product_id);
        if (item) discount = Math.min(promo.value * item.qty, item.price * item.qty);
      }
      break;
  }
  return { ok: true, promo, discount, freeItem };
}

module.exports = {
  db,
  getSetting, setSetting,
  blAddUser, blRemoveUser, blGetUser, blGetAll,
  muteAdd, muteRemove, muteGet,
  staffGet, staffCreate, staffUpdate, staffGetAll,
  vehicleAdd, vehicleGetAll, vehicleRemove,
  orgVehicleAdd, orgVehicleGetAll, orgVehicleGet,
  categoryGetAll, categoryGet, categoryAdd, categoryRemove,
  productGetAll, productGet, productAdd, productUpdate, productRemove,
  setGetAll, setGet, setItems, setAdd, setRemove,
  orderCreate, orderAddItem, orderGet, orderGetItems, orderUpdate, orderItemSetBought,
  orderGetByClient, orderGetByCourier, orderGetDailyStats,
  taxiCreate, taxiGet, taxiUpdate, taxiGetByClient, taxiGetByDriver,
  promoGet, promoUse, promoAdd, promoRemove, promoGetAll,
  applyPromo,
  onlineSet, onlineRemove, onlineGet, onlineGetAll, onlineSetMsgId,
  activityLogAdd,
  dailyStatsIncrement, dailyStatsGet, dailyStatsMarkReported, dailyStatsRange,
  mapCityGetAll, mapCityGet, mapCityAdd,
  mapCategoryGetAll, mapCategoryGet, mapCategoryAdd,
  mapPointGetAll, mapPointGet, mapPointsByCity, mapPointsByCategory,
  mapPointAdd, mapPointRemove,
  haversineKm, calcTaxiPrice,
};
