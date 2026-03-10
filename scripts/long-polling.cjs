/**
 * VK Multi-Group Bot — Groups 1 (Глав), 2 (Доставка), 3 (Такси)
 *
 * Архитектура: один процесс, три параллельных long-poll цикла.
 *
 * Группа 1 (Глав/admin bot):
 *   — ЛС: регистрация сотрудников, автопарк, CRUD каталога, управление авто орг., промокоды доставки
 *   — Чаты: !пост, !приветствие, !закреп, !кик, !увед, !диагностика, !бан, !мут, !разбан, !размут
 *   — Диспетчерская: inline-кнопка «принять заказ», экран закупок курьера
 *
 * Группа 2 (Доставка):
 *   — ЛС клиента: Главное меню → Каталог / Заказать (корзина) / Трудоустройство / FAQ
 *
 * Группа 3 (Такси):
 *   — ЛС клиента: Главное меню → Заказать такси / FAQ / Трудоустройство
 *   — Промокоды такси управляются через ЛС группы 3 (руководством)
 *
 * Чаты (общие): Руководство, Доска объявлений, Журнал активности, Спонсорская беседа
 * Чаты (доставка): Диспетчерская, Старший состав, Флудилка
 * Чаты (такси):   Диспетчерская такси, Старший состав такси, Флудилка такси
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ─────────────────────────── ENV ────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
  console.log('[Bot] .env загружен');
} else {
  console.error('[Bot] .env не найден');
}

const VK_API_VERSION = '5.131';
const G1_TOKEN = process.env.VK_GROUP1_TOKEN;
const G2_TOKEN = process.env.VK_GROUP2_TOKEN;
const G3_TOKEN = process.env.VK_GROUP3_TOKEN;
const G1_ID    = process.env.VK_GROUP1_ID;
const G2_ID    = process.env.VK_GROUP2_ID;
const G3_ID    = process.env.VK_GROUP3_ID;
const USER_TOKEN = process.env.VK_USER_TOKEN;
const ORG_BANK   = process.env.VK_ORG_BANK_ACCOUNT || '852006';

if (!G1_TOKEN || !G1_ID) { console.error('[Bot] VK_GROUP1_TOKEN / VK_GROUP1_ID не установлены'); process.exit(1); }

// ─────────────────────────── CHATS ───────────────────────────
const CHATS = {
  rukovodstvo:         parseInt(process.env.VK_CHAT_RUKOVODSTVO_ID       || '0'),
  ss:                  parseInt(process.env.VK_CHAT_SS_ID                || '0'),
  uchebny:             parseInt(process.env.VK_CHAT_UCHEBNY_ID           || '0'),
  doska:               parseInt(process.env.VK_CHAT_DOSKA_ID             || '0'),
  dispetcherskaya:     parseInt(process.env.VK_CHAT_DISPETCHERSKAYA_ID   || '0'),
  fludilka:            parseInt(process.env.VK_CHAT_FLUDILKA_ID          || '0'),
  zhurnal:             parseInt(process.env.VK_CHAT_ZHURNAL_ID           || '0'),
  sponsor:             parseInt(process.env.VK_CHAT_SPONSOR_ID           || '0'),
  taxiDispetcherskaya: parseInt(process.env.VK_CHAT_TAXI_DISPETCHERSKAYA_ID || '0'),
  taxiFludilka:        parseInt(process.env.VK_CHAT_TAXI_FLUDILKA_ID    || '0'),
  taxiSs:              parseInt(process.env.VK_CHAT_TAXI_SS_ID           || '0'),
};

// ─────────────────────────── DATA PATHS ──────────────────────
const DATA_DIR         = path.join(__dirname, 'data');
const CATALOGUE_FILE   = path.join(DATA_DIR, 'catalogue.json');
const ORDERS_FILE      = path.join(DATA_DIR, 'orders.json');
const STAFF_FILE       = path.join(DATA_DIR, 'staff.json');
const VEHICLES_FILE    = path.join(DATA_DIR, 'vehicles.json');
const PROMOS_FILE      = path.join(DATA_DIR, 'promos.json');
const TAXI_POINTS_FILE = path.join(DATA_DIR, 'taxi_points.json');
const ONLINE_FILE      = path.join(DATA_DIR, 'online_journal.json');
const REPORTS_FILE     = path.join(DATA_DIR, 'reports.json');
const BLACKLIST_FILE   = path.join(__dirname, 'blacklist.json');
const MUTES_FILE       = path.join(__dirname, 'mutes.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─────────────────────────── JSON STORE HELPERS ───────────────
function readJSON(file, def = {}) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.error('[Bot] readJSON error', file, e.message); }
  return def;
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { console.error('[Bot] writeJSON error', file, e.message); }
}

// Initialize default structures
function initJSONFile(file, def) {
  if (!fs.existsSync(file)) writeJSON(file, def);
}
initJSONFile(CATALOGUE_FILE,   { categories: [{ id: 'sets', name: 'Сеты', items: [] }], items: [], sets: [] });
initJSONFile(ORDERS_FILE,      { delivery: [], taxi: [] });
initJSONFile(STAFF_FILE,       {});
initJSONFile(VEHICLES_FILE,    { org_vehicles: [], catalog: [] });
initJSONFile(PROMOS_FILE,      { delivery: [], taxi: [] });
initJSONFile(TAXI_POINTS_FILE, { categories: [], points: [] });
initJSONFile(ONLINE_FILE,      { sessions: {}, stats: {} });
initJSONFile(REPORTS_FILE,     { delivery: [], taxi: [] });
initJSONFile(BLACKLIST_FILE,   {});
initJSONFile(MUTES_FILE,       {});

// ─────────────────────────── IN-MEMORY STATE ─────────────────
const storage = {
  greetings:      new Map(), // peerId -> text
  localBlacklist: new Map(),
  mutes:          new Map(),
  pinnedMessages: new Map(),
  // Client sessions (ЛС): userId -> { step, data }
  clientSessions: new Map(),
  // Staff registration sessions: userId -> { step, data }
  staffSessions:  new Map(),
  // Admin catalogue sessions: userId -> { step, data }
  adminSessions:  new Map(),
  // Active delivery orders: orderId -> orderObj
  activeOrders:   new Map(),
  // Active taxi orders: orderId -> orderObj
  activeTaxi:     new Map(),
  // Online journal: userId -> { nick, role, org, status, since }
  online:         new Map(),
  // Order message ids for editing: orderId -> { chatMsgId, clientMsgId }
  orderMsgIds:    new Map(),
};

// Load persisted data on start
(function bootstrap() {
  // Blacklist
  const bl = readJSON(BLACKLIST_FILE, {});
  const now = Date.now();
  for (const [uid, info] of Object.entries(bl)) {
    if (info.endDate === 0 || info.endDate > now) storage.localBlacklist.set(parseInt(uid), info);
  }
  // Mutes
  const mu = readJSON(MUTES_FILE, {});
  for (const [key, info] of Object.entries(mu)) {
    if (info.endDate > now) storage.mutes.set(key, info);
  }
  // Online journal
  const oj = readJSON(ONLINE_FILE, { sessions: {} });
  for (const [uid, info] of Object.entries(oj.sessions || {})) {
    if (info.online) storage.online.set(parseInt(uid), info);
  }
  console.log('[Bot] Bootstrap: ЧС', storage.localBlacklist.size, '| Муты', storage.mutes.size, '| Онлайн', storage.online.size);
})();

// ─────────────────────────── VK API ──────────────────────────
/**
 * groupKey: 1 | 2 | 3  (which group token to use)
 * useUserToken: boolean
 */
async function callVK(method, params = {}, groupKey = 1, useUserToken = false) {
  let token;
  if (useUserToken && USER_TOKEN) token = USER_TOKEN;
  else if (groupKey === 2) token = G2_TOKEN;
  else if (groupKey === 3) token = G3_TOKEN;
  else token = G1_TOKEN;

  const url  = `https://api.vk.com/method/${method}`;
  const body = new URLSearchParams({ ...params, access_token: token, v: VK_API_VERSION });

  const res  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const data = await res.json();
  if (data.error) throw new Error(`VK API [${method}]: ${data.error.error_msg}`);
  return data.response;
}

/** Send message using a specific group token */
async function sendMessage(peerId, message, params = {}, groupKey = 1) {
  try {
    return await callVK('messages.send', {
      peer_id: peerId, message,
      random_id: Math.floor(Math.random() * 1e9),
      ...params,
    }, groupKey);
  } catch (e) {
    console.error('[Bot] sendMessage error:', e.message);
    return null;
  }
}

/** Edit an existing message */
async function editMessage(peerId, cmid, message, params = {}, groupKey = 1) {
  try {
    return await callVK('messages.edit', {
      peer_id: peerId, conversation_message_id: cmid, message, keep_forward_messages: 1, ...params,
    }, groupKey);
  } catch (e) {
    console.error('[Bot] editMessage error:', e.message);
    return null;
  }
}

async function getUser(userId, groupKey = 1) {
  try {
    const res = await callVK('users.get', { user_ids: userId }, groupKey);
    return res[0];
  } catch (e) { console.error('[Bot] getUser:', e.message); return null; }
}

function peerIdToChatId(peerId) { return peerId - 2000000000; }

// ─────────────────────────── FORMATTERS ──────────────────────
function formatDateMSK(ts = Date.now()) {
  const d = new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function rand() { return Math.floor(Math.random() * 1e9); }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

// ─────────────────────────── BLACKLIST / MUTES ───────────────
function saveBlacklist() {
  const d = {};
  storage.localBlacklist.forEach((v, k) => { d[k] = v; });
  writeJSON(BLACKLIST_FILE, d);
}
function saveMutes() {
  const d = {};
  storage.mutes.forEach((v, k) => { d[k] = v; });
  writeJSON(MUTES_FILE, d);
}

function addToBlacklist(uid, days, reason='Нарушение правил', bannedBy=null) {
  const endDate = (days === 0 || days === 999) ? 0 : Date.now() + days*864e5;
  storage.localBlacklist.set(uid, { endDate, reason, bannedAt: Date.now(), bannedBy });
  saveBlacklist();
}
function removeFromBlacklist(uid) {
  const ok = storage.localBlacklist.delete(uid);
  if (ok) saveBlacklist();
  return ok;
}
function isBlacklisted(uid) {
  const info = storage.localBlacklist.get(uid);
  if (!info) return null;
  if (info.endDate === 0 || info.endDate > Date.now()) return info;
  removeFromBlacklist(uid);
  return null;
}

function addMute(uid, minutes, reason, mutedBy) {
  storage.mutes.set(String(uid), { endDate: Date.now() + minutes*6e4, reason, mutedAt: Date.now(), mutedBy });
  saveMutes();
}
function removeMute(uid) {
  const ok = storage.mutes.delete(String(uid));
  if (ok) saveMutes();
  return ok;
}
function isMuted(uid) {
  const info = storage.mutes.get(String(uid));
  if (!info) return null;
  if (info.endDate > Date.now()) return info;
  removeMute(uid);
  return null;
}

// ─────────────────────────── ROLES ───────────────────────────
async function getUserRole(uid) {
  // 1. Check staff profile first
  const staff = readJSON(STAFF_FILE, {});
  if (staff[uid]) return staff[uid].role || 'kurier';

  // 2. Fallback: check chat membership
  for (const [name, pid] of Object.entries(CHATS)) {
    if (!pid) continue;
    try {
      const members = await callVK('messages.getConversationMembers', { peer_id: pid });
      const found = (members.items || []).some(m => m.member_id === uid);
      if (found) {
        if (name === 'rukovodstvo') return 'rs';
        if (name === 'ss' || name === 'taxiSs') return 'ss';
      }
    } catch(_) {}
  }
  return null;
}

async function hasPermission(uid, peerId, requiredRoles) {
  const role = await getUserRole(uid);
  if (role && requiredRoles.includes(role)) return true;
  try {
    const members = await callVK('messages.getConversationMembers', { peer_id: peerId });
    const m = (members.items || []).find(x => x.member_id === uid);
    return !!(m && (m.is_admin || m.is_owner));
  } catch(_) { return false; }
}

function isAdmin(uid, peerId) { return hasPermission(uid, peerId, ['rs']); }

// ─────────────────────────── CATALOGUE HELPERS ────────────────
function loadCatalogue() { return readJSON(CATALOGUE_FILE, { categories: [], items: [], sets: [] }); }
function saveCatalogue(c) { writeJSON(CATALOGUE_FILE, c); }

function buildBasketText(items) {
  if (!items || items.length === 0) return 'Корзина пуста.';
  const lines = items.map(it => `${it.name}${it.temp ? ' | '+it.temp : ''} | ${it.price}р. (x${it.qty})`);
  const total = items.reduce((s, it) => s + it.price * it.qty, 0);
  return `Корзина:\n____________\n${lines.join('\n')}\n______________\nИтог: ${total}р.`;
}

function basketTotal(items) {
  return items.reduce((s, it) => s + it.price * it.qty, 0);
}

function applyPromo(promoCode, type, basket) {
  const promos = readJSON(PROMOS_FILE, { delivery: [], taxi: [] });
  const list = promos[type] || [];
  const p = list.find(x => x.code.toLowerCase() === promoCode.toLowerCase() && x.active);
  if (!p) return { ok: false, msg: 'Промокод не найден или неактивен.' };

  let discount = 0;
  let freeItem = null;
  let msg = '';

  if (p.type === 'percent') {
    discount = Math.round(basketTotal(basket) * p.value / 100);
    msg = `Скидка ${p.value}% — ${discount}р.`;
  } else if (p.type === 'fixed') {
    discount = p.value;
    msg = `Скидка ${p.value}р.`;
  } else if (p.type === 'free_item') {
    // free_item: { itemName, price }
    freeItem = { name: p.itemName, price: 0, qty: 1, temp: p.temp || '' };
    msg = `Бесплатный товар: ${p.itemName}`;
  } else if (p.type === 'free_delivery') {
    msg = 'Бесплатная доставка!';
  } else if (p.type === 'category_discount') {
    // discount on category
    const affected = basket.filter(it => it.categoryId === p.categoryId);
    discount = affected.reduce((s, it) => s + Math.round(it.price * it.qty * p.value / 100), 0);
    msg = `Скидка ${p.value}% на категорию «${p.categoryName}» — ${discount}р.`;
  }

  return { ok: true, discount, freeItem, msg, promo: p };
}

// ─────────────────────────── INLINE KEYBOARDS ────────────────
function kb(buttons) {
  // buttons: array of rows, each row is array of { label, color, payload }
  return JSON.stringify({
    one_time: false,
    inline: true,
    buttons: buttons.map(row =>
      row.map(btn => ({
        action: { type: 'callback', label: btn.label, payload: JSON.stringify(btn.payload || btn.label) },
        color: btn.color || 'secondary',
      }))
    ),
  });
}

function msgKb(buttons) {
  // Message keyboard (non-inline)
  return JSON.stringify({
    one_time: false,
    buttons: buttons.map(row =>
      row.map(btn => ({
        action: { type: 'text', label: btn.label, payload: JSON.stringify(btn.payload || btn.label) },
        color: btn.color || 'secondary',
      }))
    ),
  });
}

// ─────────────────────────── DELIVERY: CLIENT FLOW (Group 2) ──
const DEL_STEP = {
  MAIN:           'del_main',
  CATALOGUE_CAT:  'del_cat_cat',
  CATALOGUE_ITEM: 'del_cat_item',
  ORDER_CAT:      'del_ord_cat',
  ORDER_ITEMS:    'del_ord_items',
  BASKET:         'del_basket',
  DEL_ITEM_PICK:  'del_del_item',
  CHECKOUT_NICK:  'del_nick',
  CHECKOUT_ADDR:  'del_addr',
  CHECKOUT_CONF:  'del_conf',
  PROMO:          'del_promo',
  WAITING:        'del_waiting',
  ACTIVE:         'del_active',
};

function clientSession(uid) {
  if (!storage.clientSessions.has(uid)) {
    storage.clientSessions.set(uid, { step: DEL_STEP.MAIN, data: {} });
  }
  return storage.clientSessions.get(uid);
}

async function handleDeliveryDM(event) {
  const uid    = event.from_id;
  const text   = (event.text || '').trim();
  const peerId = event.peer_id;

  const sess = clientSession(uid);

  // ── Main menu ─────────────────────────────────────────────
  if (text === 'начать' || text === '/start' || sess.step === DEL_STEP.MAIN) {
    sess.step = DEL_STEP.MAIN;
    await sendMessage(peerId,
      'Добро пожаловать! Выберите раздел:',
      { keyboard: msgKb([
          [{ label: 'Главное меню', color: 'primary' }],
          [{ label: 'Каталог', color: 'secondary' }, { label: 'Заказать', color: 'positive' }],
          [{ label: 'Трудоустройство', color: 'secondary' }, { label: 'Частые вопросы', color: 'secondary' }],
        ]) }, 2);
    if (text !== 'Главное меню' && text !== 'начать' && text !== '/start') return;
  }

  if (text === 'Главное меню') {
    sess.step = DEL_STEP.MAIN;
    sess.data = {};
    await sendMessage(peerId,
      'Главное меню. Выберите раздел:',
      { keyboard: msgKb([
          [{ label: 'Каталог', color: 'secondary' }, { label: 'Заказать', color: 'positive' }],
          [{ label: 'Трудоустройство', color: 'secondary' }, { label: 'Частые вопросы', color: 'secondary' }],
        ]) }, 2);
    return;
  }

  // ── Трудоустройство ──────────────────────────────────────
  if (text === 'Трудоустройство') {
    await sendMessage(peerId,
      'Для трудоустройства напишите в личные сообщения нашего сообщества или свяжитесь с администратором.\nДля возврата нажмите «Главное меню».',
      { keyboard: msgKb([[{ label: 'Главное меню', color: 'secondary' }]]) }, 2);
    return;
  }

  // ── Частые вопросы ────────────────────────────────────────
  if (text === 'Частые вопросы') {
    await sendMessage(peerId,
      'Частые вопросы:\n\n❓ Как сделать заказ?\nНажмите «Заказать» в главном меню.\n\n❓ Как отследить заказ?\nПосле принятия заказа статус появится в этом чате.\n\n❓ Можно ли отменить заказ?\nДа, до того как курьер его принял.\n\n❓ Как оставить отзыв?\nПосле завершения заказа придёт ссылка.',
      { keyboard: msgKb([[{ label: 'Главное меню', color: 'secondary' }]]) }, 2);
    return;
  }

  // ── Каталог ───────────────────────────────────────────────
  if (text === 'Каталог') {
    sess.step = DEL_STEP.CATALOGUE_CAT;
    const cat = loadCatalogue();
    const rows = cat.categories.map(c => [{ label: c.name }]);
    rows.push([{ label: 'Главное меню', color: 'secondary' }]);
    await sendMessage(peerId, 'Выберите категорию:', { keyboard: msgKb(rows) }, 2);
    return;
  }

  if (sess.step === DEL_STEP.CATALOGUE_CAT) {
    if (text === 'Назад' || text === 'Главное меню') { sess.step = DEL_STEP.MAIN; return; }
    const cat = loadCatalogue();
    const category = cat.categories.find(c => c.name === text);
    if (!category) return;
    // Show photos/items in category
    const items = cat.items.filter(it => it.categoryId === category.id);
    const sets  = category.id === 'sets' ? cat.sets : [];
    const all   = [...items, ...sets];
    if (all.length === 0) {
      await sendMessage(peerId, 'В этой категории пока нет товаров.', { keyboard: msgKb([[{ label: 'Назад' }]]) }, 2);
      return;
    }
    sess.step = DEL_STEP.CATALOGUE_ITEM;
    sess.data.catName = category.name;
    // Send each item with photo if available
    for (const it of all.slice(0, 10)) {
      const caption = `${it.name} | ${it.price}р.`;
      if (it.photoId) {
        await sendMessage(peerId, caption, { attachment: it.photoId }, 2);
      } else {
        await sendMessage(peerId, caption, {}, 2);
      }
    }
    await sendMessage(peerId, `Категория: ${category.name}`, { keyboard: msgKb([[{ label: 'Назад' }]]) }, 2);
    return;
  }

  if (sess.step === DEL_STEP.CATALOGUE_ITEM && text === 'Назад') {
    sess.step = DEL_STEP.CATALOGUE_CAT;
    const cat = loadCatalogue();
    const rows = cat.categories.map(c => [{ label: c.name }]);
    rows.push([{ label: 'Главное меню', color: 'secondary' }]);
    await sendMessage(peerId, 'Выберите категорию:', { keyboard: msgKb(rows) }, 2);
    return;
  }

  // ── Заказать ──────────────────────────────────────────────
  if (text === 'Заказать') {
    sess.step = DEL_STEP.ORDER_CAT;
    sess.data.basket = [];
    const cat = loadCatalogue();
    const rows = cat.categories.map(c => [{ label: c.name }]);
    rows.push([{ label: 'Главное меню', color: 'secondary' }]);
    const msgId = await sendMessage(peerId, 'Выберите категорию товара:', { keyboard: msgKb(rows) }, 2);
    sess.data.orderMsgId = msgId;
    return;
  }

  if (sess.step === DEL_STEP.ORDER_CAT) {
    if (text === 'Главное меню') { sess.step = DEL_STEP.MAIN; sess.data = {}; return; }
    const cat = loadCatalogue();
    const category = cat.categories.find(c => c.name === text);
    if (!category) return;
    sess.step = DEL_STEP.ORDER_ITEMS;
    sess.data.currentCat = category.id;
    sess.data.currentCatName = category.name;
    sess.data.currentPage = 0;

    await showOrderItems(peerId, uid, sess, category, cat, 2);
    return;
  }

  if (sess.step === DEL_STEP.ORDER_ITEMS) {
    const cat = loadCatalogue();
    const category = cat.categories.find(c => c.id === sess.data.currentCat);
    const items = getItemsForCategory(cat, category);

    if (text === '← Назад к категориям') {
      sess.step = DEL_STEP.ORDER_CAT;
      const rows = cat.categories.map(c => [{ label: c.name }]);
      rows.push([{ label: 'Главное меню', color: 'secondary' }]);
      await sendMessage(peerId, buildBasketText(sess.data.basket) + '\n\nВыберите категорию:', { keyboard: msgKb(rows) }, 2);
      return;
    }
    if (text === '→ Далее') {
      sess.data.currentPage = (sess.data.currentPage || 0) + 1;
      await showOrderItems(peerId, uid, sess, category, cat, 2);
      return;
    }
    if (text === '← Пред.') {
      sess.data.currentPage = Math.max(0, (sess.data.currentPage || 0) - 1);
      await showOrderItems(peerId, uid, sess, category, cat, 2);
      return;
    }
    if (text === 'Корзина') {
      sess.step = DEL_STEP.BASKET;
      await showBasket(peerId, uid, sess, 2);
      return;
    }

    // Check if selected item
    const item = items.find(it => it.name === text);
    if (item) {
      const existing = sess.data.basket.find(it => it.id === item.id);
      if (existing) { existing.qty++; }
      else { sess.data.basket.push({ ...item, qty: 1 }); }
      await sendMessage(peerId, `«${item.name}» добавлен в корзину.`, {}, 2);
      await showOrderItems(peerId, uid, sess, category, cat, 2);
    }
    return;
  }

  // ── Basket ────────────────────────────────────────────────
  if (sess.step === DEL_STEP.BASKET) {
    if (text === 'Добавить товар') {
      sess.step = DEL_STEP.ORDER_CAT;
      const cat = loadCatalogue();
      const rows = cat.categories.map(c => [{ label: c.name }]);
      rows.push([{ label: 'Главное меню', color: 'secondary' }]);
      await sendMessage(peerId, buildBasketText(sess.data.basket) + '\n\nВыберите категорию:', { keyboard: msgKb(rows) }, 2);
      return;
    }
    if (text === 'Удалить товар') {
      sess.step = DEL_STEP.DEL_ITEM_PICK;
      const names = [...new Set(sess.data.basket.map(it => it.name))];
      const rows = names.map(n => [{ label: n }]);
      rows.push([{ label: 'Отмена', color: 'negative' }]);
      await sendMessage(peerId, 'Какой товар удалить?', { keyboard: msgKb(rows) }, 2);
      return;
    }
    if (text === 'Очистить корзину') {
      sess.data.basket = [];
      sess.step = DEL_STEP.ORDER_CAT;
      const cat = loadCatalogue();
      const rows = cat.categories.map(c => [{ label: c.name }]);
      rows.push([{ label: 'Главное меню', color: 'secondary' }]);
      await sendMessage(peerId, 'Корзина очищена. Выберите категорию:', { keyboard: msgKb(rows) }, 2);
      return;
    }
    if (text === 'Оформить заказ') {
      if (!sess.data.basket || sess.data.basket.length === 0) {
        await sendMessage(peerId, 'Корзина пуста. Добавьте товары.', {}, 2);
        return;
      }
      sess.step = DEL_STEP.CHECKOUT_NICK;
      await sendMessage(peerId, buildBasketText(sess.data.basket) + '\n\nВведите ваш никнейм в игре:', { keyboard: msgKb([[{ label: 'Отмена', color: 'negative' }]]) }, 2);
      return;
    }
    if (text === 'Назад' || text === 'Главное меню') {
      sess.step = DEL_STEP.MAIN; sess.data = {};
      await sendMessage(peerId, 'Главное меню:', { keyboard: msgKb([[{ label: 'Каталог' }, { label: 'Заказать' }], [{ label: 'Трудоустройство' }, { label: 'Частые вопросы' }]]) }, 2);
      return;
    }
    return;
  }

  if (sess.step === DEL_STEP.DEL_ITEM_PICK) {
    if (text === 'Отмена') { sess.step = DEL_STEP.BASKET; await showBasket(peerId, uid, sess, 2); return; }
    const idx = sess.data.basket.findIndex(it => it.name === text);
    if (idx !== -1) {
      if (sess.data.basket[idx].qty > 1) { sess.data.basket[idx].qty--; }
      else { sess.data.basket.splice(idx, 1); }
    }
    sess.step = DEL_STEP.BASKET;
    await showBasket(peerId, uid, sess, 2);
    return;
  }

  // ── Checkout ──────────────────────────────────────────────
  if (sess.step === DEL_STEP.CHECKOUT_NICK) {
    if (text === 'Отмена') { sess.step = DEL_STEP.BASKET; await showBasket(peerId, uid, sess, 2); return; }
    sess.data.nick = text;
    sess.step = DEL_STEP.CHECKOUT_ADDR;
    await sendMessage(peerId, 'Укажите место доставки (точка на карте, адрес):', { keyboard: msgKb([[{ label: 'Отмена', color: 'negative' }]]) }, 2);
    return;
  }

  if (sess.step === DEL_STEP.CHECKOUT_ADDR) {
    if (text === 'Отмена') { sess.step = DEL_STEP.BASKET; await showBasket(peerId, uid, sess, 2); return; }
    sess.data.address = text;
    sess.step = DEL_STEP.CHECKOUT_CONF;
    const summary = `Проверьте данные заказа:\n\nНикнейм: ${sess.data.nick}\nМесто: ${sess.data.address}\n\n${buildBasketText(sess.data.basket)}\n\nВсё верно?`;
    await sendMessage(peerId, summary, { keyboard: msgKb([[{ label: 'Верно', color: 'positive' }, { label: 'Изменить', color: 'secondary' }]]) }, 2);
    return;
  }

  if (sess.step === DEL_STEP.CHECKOUT_CONF) {
    if (text === 'Изменить') { sess.step = DEL_STEP.CHECKOUT_NICK; await sendMessage(peerId, 'Введите никнейм:', {}, 2); return; }
    if (text === 'Верно') {
      sess.step = DEL_STEP.PROMO;
      await sendMessage(peerId, 'Есть промокод? Введите его или нажмите «Пропустить»:', { keyboard: msgKb([[{ label: 'Пропустить', color: 'secondary' }]]) }, 2);
      return;
    }
    return;
  }

  if (sess.step === DEL_STEP.PROMO) {
    let promoResult = null;
    if (text !== 'Пропустить') {
      promoResult = applyPromo(text, 'delivery', sess.data.basket);
      if (!promoResult.ok) {
        await sendMessage(peerId, promoResult.msg + '\nВведите другой промокод или нажмите «Пропустить»:', { keyboard: msgKb([[{ label: 'Пропустить', color: 'secondary' }]]) }, 2);
        return;
      }
      sess.data.promo = promoResult;
      if (promoResult.freeItem) sess.data.basket.push(promoResult.freeItem);
    }

    // Create order
    const orderId = genId();
    const order = {
      id:        orderId,
      type:      'delivery',
      clientId:  uid,
      nick:      sess.data.nick,
      address:   sess.data.address,
      basket:    [...sess.data.basket],
      total:     basketTotal(sess.data.basket) - (promoResult?.discount || 0),
      promo:     promoResult ? promoResult.promo?.code : null,
      promoDesc: promoResult ? promoResult.msg : null,
      status:    'pending',
      createdAt: Date.now(),
    };
    storage.activeOrders.set(orderId, order);

    // Persist
    const ords = readJSON(ORDERS_FILE, { delivery: [], taxi: [] });
    ords.delivery.push(order);
    writeJSON(ORDERS_FILE, ords);

    // Send to dispatch chat
    await sendOrderToDispatch(order);

    sess.step = DEL_STEP.WAITING;
    sess.data.orderId = orderId;
    const promoText = promoResult ? `\nПромокод: ${promoResult.msg}` : '';
    await sendMessage(peerId, `Заказ оформлен!${promoText}\n\nОжидайте принятия заказа. Вы получите уведомление, когда курьер примет заказ.\n\nВы можете проверить статус заказа в любое время.`,
      { keyboard: msgKb([[{ label: 'Статус заказа' }], [{ label: 'Главное меню', color: 'secondary' }]]) }, 2);
    return;
  }

  if (sess.step === DEL_STEP.WAITING || sess.step === DEL_STEP.ACTIVE) {
    if (text === 'Статус заказа') {
      const order = storage.activeOrders.get(sess.data.orderId);
      if (!order) { await sendMessage(peerId, 'Заказ не найден или завершён.', {}, 2); return; }
      const statusMap = { pending: 'Ожидает курьера', accepted: 'Заказ готовится', delivering: 'Курьер едет к вам', arrived: 'Курьер на месте', done: 'Завершён' };
      await sendMessage(peerId, `Статус заказа: ${statusMap[order.status] || order.status}\nКурьер: ${order.courierNick || 'не назначен'}`, {}, 2);
      return;
    }
    if (text === 'Ссы��ка на курьера') {
      const order = storage.activeOrders.get(sess.data.orderId);
      if (!order || !order.courierId) { await sendMessage(peerId, 'Курьер ещё не назначен.', {}, 2); return; }
      sess.data.awaitingCourierLinkConfirm = true;
      await sendMessage(peerId, 'Вы уверены, что хотите получить ссылку на переписку с курьером?', { keyboard: msgKb([[{ label: 'Да', color: 'positive' }, { label: 'Нет', color: 'negative' }]]) }, 2);
      return;
    }
    if (sess.data.awaitingCourierLinkConfirm) {
      sess.data.awaitingCourierLinkConfirm = false;
      if (text === 'Да') {
        const order = storage.activeOrders.get(sess.data.orderId);
        if (!order || !order.courierId) { await sendMessage(peerId, 'Курьер не назначен.', {}, 2); return; }
        // Notify courier about link request
        await sendMessage(order.courierId,
          `Клиент ${order.nick} запрашивает ссылку на вашу переписку. Разрешить?`,
          { keyboard: msgKb([[{ label: `Разрешить#${order.id}`, color: 'positive' }, { label: `Отклонить#${order.id}`, color: 'negative' }]]) }, 1);
        await sendMessage(peerId, 'Запрос отправлен курьеру. Ожидайте ответа.', {}, 2);
      } else {
        await sendMessage(peerId, 'Отменено.', {}, 2);
      }
      return;
    }
    if (text === 'Главное меню') { sess.step = DEL_STEP.MAIN; sess.data = {}; return; }
    return;
  }
}

async function showOrderItems(peerId, uid, sess, category, cat, groupKey) {
  const PAGE_SIZE = 5;
  const items = getItemsForCategory(cat, category);
  const page  = sess.data.currentPage || 0;
  const slice = items.slice(page * PAGE_SIZE, (page+1) * PAGE_SIZE);

  const rows = slice.map(it => [{ label: it.name }]);
  const nav = [];
  if (page > 0) nav.push({ label: '← Пред.', color: 'secondary' });
  if ((page+1) * PAGE_SIZE < items.length) nav.push({ label: '→ Далее', color: 'secondary' });
  if (nav.length) rows.push(nav);
  rows.push([{ label: '← Назад к категориям', color: 'secondary' }, { label: 'Корзина', color: 'positive' }]);

  const basketInfo = sess.data.basket.length > 0
    ? `\n\n${buildBasketText(sess.data.basket)}`
    : '\n\nКорзина пуста.';

  await sendMessage(peerId, `Категория: ${category.name}\nСтраница ${page+1}${basketInfo}`, { keyboard: msgKb(rows) }, groupKey);
}

function getItemsForCategory(cat, category) {
  if (!category) return [];
  if (category.id === 'sets') {
    return cat.sets.map(s => ({ ...s, id: 'set_'+s.id }));
  }
  return cat.items.filter(it => it.categoryId === category.id);
}

async function showBasket(peerId, uid, sess, groupKey) {
  const rows = [
    [{ label: 'Добавить товар', color: 'secondary' }, { label: 'Удалить товар', color: 'negative' }],
    [{ label: 'Очистить корзину', color: 'negative' }],
    [{ label: 'Оформить заказ', color: 'positive' }],
    [{ label: 'Главное меню', color: 'secondary' }],
  ];
  await sendMessage(peerId, buildBasketText(sess.data.basket), { keyboard: msgKb(rows) }, groupKey);
}

// ─────────────────────────── DISPATCH: SEND ORDER TO CHAT ─────
async function sendOrderToDispatch(order) {
  const lines = order.basket.map(it => `${it.name}${it.temp ? ' | '+it.temp : ''} | ${it.price}р. (x${it.qty})`);
  const total = order.total;
  const text = `🆕 Новый заказ #${order.id.slice(-6)}\n\nНикнейм: ${order.nick}\nМесто: ${order.address}\nЗаказ:\n${lines.join('\n')}\nИтого: ${total}р.${order.promoDesc ? '\n'+order.promoDesc : ''}`;

  const keyboard = kb([[{ label: 'Принять заказ', color: 'positive', payload: { action: 'accept_order', orderId: order.id } }]]);

  const chatId = order.type === 'taxi' ? CHATS.taxiDispetcherskaya : CHATS.dispetcherskaya;
  const msgId  = await sendMessage(chatId, text, { keyboard }, 1);
  if (msgId) {
    storage.orderMsgIds.set(order.id, { dispatchMsgId: msgId, chatId });
  }

  // Auto-check after 3 minutes if not accepted
  setTimeout(() => checkUnacceptedOrder(order.id, order.type), 3 * 60 * 1000);
}

async function checkUnacceptedOrder(orderId, type) {
  const order = type === 'taxi' ? storage.activeTaxi.get(orderId) : storage.activeOrders.get(orderId);
  if (!order || order.status !== 'pending') return;

  // Check if any online couriers exist
  const onlineCouriers = getOnlineCouriers(type);
  if (onlineCouriers.length === 0) return;

  const ssChatId = type === 'taxi' ? CHATS.taxiSs : CHATS.ss;
  const listText = onlineCouriers.map(c => `@${c.nick} (${c.role})`).join(', ');
  await sendMessage(ssChatId, `⚠️ Заказ #${orderId.slice(-6)} не принят за 3 минуты!\nКурьеры в сети: ${listText}\n\nПожалуйста, примите заказ.`, {}, 1);

  // Re-notify couriers
  for (const c of onlineCouriers) {
    if (c.uid) {
      await sendMessage(c.uid, `⚠️ Заказ #${orderId.slice(-6)} ждёт принятия уже 3 минуты!`, {}, 1);
    }
  }
}

function getOnlineCouriers(type) {
  const staff = readJSON(STAFF_FILE, {});
  const result = [];
  storage.online.forEach((info, uid) => {
    const profile = staff[uid];
    if (!profile) return;
    const inDelivery = profile.groups && profile.groups.includes('delivery');
    const inTaxi     = profile.groups && profile.groups.includes('taxi');
    if (type === 'delivery' && !inDelivery) return;
    if (type === 'taxi' && !inTaxi) return;
    if (info.online && info.status !== 'afk') {
      result.push({ uid, nick: info.nick, role: info.role });
    }
  });
  return result;
}

// ─────────────────────────── COURIER: ACCEPT & PURCHASE ───────
async function handleCourierAcceptOrder(event, orderId) {
  const uid = event.from_id;
  const staff = readJSON(STAFF_FILE, {});
  const profile = staff[uid];

  if (!profile) {
    await sendMessage(uid, 'Сначала создайте профиль сотрудника командой в ЛС.', {}, 1);
    return;
  }

  // Check vehicles
  if (!profile.vehicles || profile.vehicles.length === 0) {
    await sendMessage(uid, 'У вас нет транспортного средства. Добавьте авто в профиле.', {}, 1);
    return;
  }

  // Check online status
  const onlineInfo = storage.online.get(uid);
  if (!onlineInfo || !onlineInfo.online) {
    await sendMessage(uid, 'Вы не в онлайне. Используйте !онлайн в журнале активности.', {}, 1);
    return;
  }

  const order = storage.activeOrders.get(orderId) || storage.activeTaxi.get(orderId);
  if (!order) { await sendMessage(uid, 'Заказ не найден.', {}, 1); return; }
  if (order.status !== 'pending') { await sendMessage(uid, 'Заказ уже принят.', {}, 1); return; }

  // Move to DM to get courier nick and ETA
  const aSess = storage.staffSessions.get(uid) || {};
  aSess.step = 'courier_accept_nick';
  aSess.data = { orderId, orderType: order.type || 'delivery' };
  storage.staffSessions.set(uid, aSess);

  await sendMessage(uid, `Принятие заказа #${orderId.slice(-6)}.\n\nУкажите ваш никнейм:`, { keyboard: msgKb([[{ label: 'Отмена', color: 'negative' }]]) }, 1);
}

async function buildPurchaseScreen(uid, order) {
  // Build purchase list for courier
  const cat = loadCatalogue();
  const toBuy = []; // { name, qty }

  for (const item of order.basket) {
    // If item has sub-items
    const fullItem = cat.items.find(it => it.id === item.id) || cat.sets.find(s => 'set_'+s.id === item.id);
    if (fullItem && fullItem.subItems && fullItem.subItems.length > 0) {
      for (const sub of fullItem.subItems) {
        const existing = toBuy.find(b => b.name === sub.name);
        if (existing) existing.qty += sub.qty * item.qty;
        else toBuy.push({ name: sub.name, qty: sub.qty * item.qty, instruction: sub.instruction, type: sub.type });
      }
    } else {
      const existing = toBuy.find(b => b.name === item.name);
      if (existing) existing.qty += item.qty;
      else toBuy.push({ name: item.name, qty: item.qty, instruction: fullItem?.instruction || null });
    }
  }

  // Group: simple (just buy), needs cooking
  const simple  = toBuy.filter(it => !it.instruction || it.type === 'buy');
  const cooking = toBuy.filter(it => it.instruction && it.type !== 'buy');

  let text = `Заказ #${order.id.slice(-6)} — Купить:\n`;
  if (simple.length) text += `Общее: ${simple.map(s => `${s.name} x${s.qty}`).join('; ')}\n`;
  if (cooking.length) {
    for (const c of cooking) {
      text += `${c.name}: ${c.instruction}\n`;
    }
  }

  // Create toggle buttons for each item
  const buttons = toBuy.map(it => ([{
    label: `[ ] ${it.name} x${it.qty}`,
    color: 'secondary',
    payload: { action: 'toggle_buy', orderId: order.id, itemName: it.name },
  }]));
  buttons.push([{ label: 'Всё куплено / Готовлю', color: 'positive', payload: { action: 'cooking_done', orderId: order.id } }]);

  const keyboard = kb(buttons);
  const msgId = await sendMessage(uid, text, { keyboard }, 1);

  // Store purchase state
  order.purchaseItems = toBuy.map(it => ({ ...it, bought: false }));
  order.purchaseMsgId = msgId;
}

async function buildTaxiDriverScreen(uid, order) {
  const passText = order.passengers && order.passengers.length
    ? `\nПопутчики: ${order.passengers.join(', ')}`
    : '';
  const payText = order.payment?.type === 'cash' ? 'Наличными'
    : order.payment?.type === 'phone' ? 'Счёт телефона' : 'Банковский счёт';
  const text = `Такси #${order.id.slice(-6)}\n\nКлиент: ${order.nick}${passText}\nОткуда: ${order.from?.name || '—'}\nКуда: ${order.to?.name || '—'}\nСумма: ${order.finalPrice}р. (${payText})`;

  const buttons = [
    [{ label: 'Прибыл к клиенту', color: 'positive', payload: { action: 'courier_arrived', orderId: order.id } }],
    [{ label: 'Платное ожидание', color: 'secondary', payload: { action: 'taxi_paid_waiting', orderId: order.id } }],
    [{ label: 'Завершить поездку', color: 'positive', payload: { action: 'finish_order', orderId: order.id } }],
    [{ label: `Связь с клиентом: vk.me/id${order.clientId}`, color: 'secondary', payload: { action: 'noop' } }],
  ];
  const msgId = await sendMessage(uid, text, { keyboard: kb(buttons) }, 1);
  order.driverMsgId = msgId;
}

// ─────────────────────────── STAFF: GROUP 1 DMs ───────────────
const STAFF_STEP = {
  NONE:           'none',
  REG_NICK:       'reg_nick',
  REG_BANK:       'reg_bank',
  REG_DONE:       'reg_done',
  VEHICLE_MENU:   'veh_menu',
  VEHICLE_ADD:    'veh_add_type',
  VEHICLE_PERSONAL_NAME: 'veh_pers_name',
  VEHICLE_PERSONAL_COLOR: 'veh_pers_color',
  VEHICLE_PERSONAL_PHOTO: 'veh_pers_photo',
  VEHICLE_ORG_SELECT: 'veh_org_select',
  PROFILE_VIEW:   'profile_view',
  // Courier accept flow
  COURIER_ACCEPT_NICK: 'courier_accept_nick',
  COURIER_ACCEPT_ETA:  'courier_accept_eta',
};

async function handleGroup1DM(event) {
  const uid    = event.from_id;
  const text   = (event.text || '').trim();
  const peerId = event.peer_id; // same as uid for DMs

  const staff = readJSON(STAFF_FILE, {});
  const role  = await getUserRole(uid);
  const isRs  = role === 'rs';
  const isSs  = role === 'ss' || isRs;
  const profile = staff[uid];

  const sess = storage.staffSessions.get(uid) || { step: STAFF_STEP.NONE, data: {} };
  const step = sess.step;

  // ── Courier accept flow ───────────────────────────────────
  if (step === 'courier_accept_nick') {
    if (text === 'Отмена') { storage.staffSessions.delete(uid); await sendMessage(peerId, 'Отменено.', {}, 1); return; }
    sess.data.courierNick = text;
    sess.step = 'courier_accept_eta';
    storage.staffSessions.set(uid, sess);
    await sendMessage(peerId, 'Укажите примерное время ожидания (например: 15 минут):', { keyboard: msgKb([[{ label: 'Отмена', color: 'negative' }]]) }, 1);
    return;
  }

  if (step === 'courier_accept_eta') {
    if (text === 'Отмена') { storage.staffSessions.delete(uid); await sendMessage(peerId, 'Отменено.', {}, 1); return; }
    const { orderId, orderType } = sess.data;
    const order = orderType === 'taxi' ? storage.activeTaxi.get(orderId) : storage.activeOrders.get(orderId);

    if (!order) { await sendMessage(peerId, 'Заказ не найден.', {}, 1); return; }

    order.courierId   = uid;
    order.courierNick = sess.data.courierNick;
    order.eta         = text;
    order.status      = 'accepted';

    // Notify client
    const clientPeer = order.clientId;
    await sendMessage(clientPeer,
      `Ваш заказ принят!\nКурьер: ${order.courierNick}\nПримерное время ожидания: ${order.eta}`,
      { keyboard: msgKb([[{ label: 'Статус заказа' }, { label: 'Ссылка на курьера' }], [{ label: 'Главное меню', color: 'secondary' }]]) }, 2);

    // For delivery: build purchase/cooking screen; for taxi: show driver action screen
    if (order.type === 'taxi') {
      await buildTaxiDriverScreen(uid, order);
    } else {
      await buildPurchaseScreen(uid, order);
    }

    storage.staffSessions.delete(uid);
    return;
  }

  // ── Courier link request response ─────────────────────────
  if (text.startsWith('Разрешить#') || text.startsWith('Отклонить#')) {
    const [action, orderId] = text.split('#');
    const order = storage.activeOrders.get(orderId) || storage.activeTaxi.get(orderId);
    if (!order) { await sendMessage(peerId, 'Заказ не найден.', {}, 1); return; }
    if (action === 'Разрешить') {
      const link = `vk.me/id${uid}`;
      await sendMessage(order.clientId, `Курьер разрешил. Ссылка: ${link}`, {}, 2);
    } else {
      await sendMessage(order.clientId, 'Курьер отклонил запрос на ссылку.', {}, 2);
    }
    return;
  }

  // ── Admin: catalogue management ───────────────────────────
  if (isSs) {
    const adminResult = await handleAdminCatalogueSession(uid, peerId, text, event);
    if (adminResult) return;
    const adminResult2 = await handleAdminPromosSession(uid, peerId, text, event, role);
    if (adminResult2) return;
    const adminResult3 = await handleAdminVehiclesSession(uid, peerId, text, event);
    if (adminResult3) return;
  }

  // ── Staff registration / profile ─────────────────────────
  if (!profile && step === STAFF_STEP.NONE) {
    if (text.toLowerCase() === 'регистрация' || text.toLowerCase() === 'начать') {
      sess.step = STAFF_STEP.REG_NICK;
      storage.staffSessions.set(uid, sess);
      await sendMessage(peerId, 'Добро пожаловать!\nДля работы с ботом необходима регистрация.\n\nВведите ваш ник (игровое имя):', {}, 1);
      return;
    }
    await sendMessage(peerId, 'Для начала работы введите «Регистрация».', {}, 1);
    return;
  }

  if (step === STAFF_STEP.REG_NICK) {
    sess.data.nick = text;
    sess.step = STAFF_STEP.REG_BANK;
    storage.staffSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите номер вашего банковского счёта (для выплат):', {}, 1);
    return;
  }

  if (step === STAFF_STEP.REG_BANK) {
    sess.data.bank = text;
    // Save profile
    const newProfile = {
      uid, nick: sess.data.nick, bank: sess.data.bank,
      role: 'kurier', groups: [],
      vehicles: [], orgVehicles: [],
      stats: { deliveryOrders: 0, taxiOrders: 0 },
      createdAt: Date.now(),
    };
    staff[uid] = newProfile;
    writeJSON(STAFF_FILE, staff);
    sess.step = STAFF_STEP.NONE;
    storage.staffSessions.set(uid, sess);
    await sendMessage(peerId,
      `Профиль создан!\nНик: ${sess.data.nick}\nБанк. счёт: ${sess.data.bank}\n\nТеперь добавьте транспортное средство, чтобы принимать заказы.\n\nВведите «Мой профиль» или «Автопарк».`,
      {}, 1);
    return;
  }

  // ── Main staff menu ───────────────────────────────────────
  if (!profile) {
    await sendMessage(peerId, 'Введите «Регистрация» для начала работы.', {}, 1);
    return;
  }

  if (text === 'Мой профиль' || text === 'профиль') {
    const cars = (profile.vehicles || []).map(v => `  • ${v.name}${v.isOrg ? ' [орг]' : ''}${v.brandColor ? ' [фирм.]' : ''}`).join('\n');
    const orgCars = (profile.orgVehicles || []).map(v => `  • ${v.name}`).join('\n');
    const text2 = `Профиль сотрудника:\n\nНик: ${profile.nick}\nБанк. счёт: ${profile.bank}\nРоль: ${profile.role}\n\nЛичный автопарк:\n${cars || '  (нет)'}\nАвто организации:\n${orgCars || '  (нет)'}\n\nСтатистика:\n  Заказы доставки: ${profile.stats?.deliveryOrders || 0}\n  Заказы такси: ${profile.stats?.taxiOrders || 0}`;
    await sendMessage(peerId, text2, { keyboard: msgKb([[{ label: 'Автопарк' }, { label: 'Изменить ник' }, { label: 'Изменить счёт' }]]) }, 1);
    return;
  }

  if (text === 'Автопарк') {
    await showVehicleMenu(uid, peerId, profile);
    return;
  }

  if (text === 'Изменить ник') {
    sess.step = 'change_nick';
    storage.staffSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите новый ник:', {}, 1);
    return;
  }
  if (step === 'change_nick') {
    profile.nick = text;
    writeJSON(STAFF_FILE, staff);
    sess.step = STAFF_STEP.NONE;
    storage.staffSessions.set(uid, sess);
    await sendMessage(peerId, `Ник изменён на: ${text}`, {}, 1);
    return;
  }

  if (text === 'Изменить счёт') {
    sess.step = 'change_bank';
    storage.staffSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите новый банковский счёт:', {}, 1);
    return;
  }
  if (step === 'change_bank') {
    profile.bank = text;
    writeJSON(STAFF_FILE, staff);
    sess.step = STAFF_STEP.NONE;
    storage.staffSessions.set(uid, sess);
    await sendMessage(peerId, `Банковский счёт изменён.`, {}, 1);
    return;
  }

  // Senior staff: view employee profiles
  if (isSs && text.startsWith('Профиль ')) {
    const targetNick = text.slice(8).trim();
    const target = Object.values(staff).find(s => s.nick.toLowerCase() === targetNick.toLowerCase());
    if (!target) { await sendMessage(peerId, `Сотрудник «${targetNick}» не найден.`, {}, 1); return; }
    const cars = (target.vehicles || []).map(v => `  • ${v.name}${v.brandColor ? ' [фирм.]' : ''}${v.photo ? ' [фото есть]' : ''}`).join('\n');
    await sendMessage(peerId,
      `Профиль: ${target.nick}\nРоль: ${target.role}\nБанк: ${target.bank}\nАвтопарк:\n${cars || '  (нет)'}\nЗаказы доставки: ${target.stats?.deliveryOrders || 0}\nЗаказы такси: ${target.stats?.taxiOrders || 0}`,
      {}, 1);
    return;
  }

  // Admin commands
  if (isRs) {
    if (text.startsWith('Добавить категорию') || text.startsWith('Добавить товар') || text.startsWith('Добавить сет') ||
        text.startsWith('Управление каталогом') || text.startsWith('Управление промокодами') ||
        text.startsWith('Управление авто')) {
      await handleAdminCommand(uid, peerId, text, role);
      return;
    }
  }

  // Default
  const menu = [`Доступные команды:`];
  menu.push('• «Мой профиль» — просмотр профиля');
  menu.push('• «Автопарк» — управление транспортом');
  if (isSs) menu.push('• «Управление каталогом» — CRUD товаров (РС/СС)');
  if (isRs) menu.push('• «Управление промокодами» — промокоды');
  if (isRs) menu.push('• «Управление авто» — авто организации');
  if (isSs) menu.push('• «Профиль [ник]» — просмотр сотрудника');
  await sendMessage(peerId, menu.join('\n'), {}, 1);
}

// ─────────────────────────── VEHICLE MANAGEMENT ───────────────
async function showVehicleMenu(uid, peerId, profile) {
  const vehicles = readJSON(VEHICLES_FILE, { org_vehicles: [], catalog: [] });
  const text = `Автопарк:\n\nЛичные авто:\n${(profile.vehicles || []).map(v => `• ${v.name}${v.brandColor ? ' [фирм.]' : ''}`).join('\n') || '(нет)'}\n\nАвто организации:\n${(profile.orgVehicles || []).map(v => `• ${v.name}`).join('\n') || '(нет)'}`;
  await sendMessage(peerId, text, {
    keyboard: msgKb([
      [{ label: 'Добавить личное авто' }, { label: 'Взять авто организации' }],
      [{ label: 'Удалить авто' }],
      [{ label: 'Мой профиль', color: 'secondary' }],
    ])
  }, 1);
}

async function handleAdminVehiclesSession(uid, peerId, text, event) {
  const sess = storage.adminSessions.get(uid) || { step: null, data: {} };
  const step = sess.step;

  if (text === 'Управление авто') {
    const vehicles = readJSON(VEHICLES_FILE, { org_vehicles: [], catalog: [] });
    const orgList = vehicles.org_vehicles.map(v => `• ${v.name}`).join('\n') || '(нет)';
    const catList = vehicles.catalog.map(v => `• ${v.name}`).join('\n') || '(нет)';
    await sendMessage(peerId,
      `Управление транспортом организации:\n\nАвто в орг. парке:\n${orgList}\n\nКаталог авто (для выбора сотрудниками):\n${catList}`,
      { keyboard: msgKb([[{ label: 'Добавить авто в каталог' }, { label: 'Добавить авто организации' }], [{ label: 'Удалить авто из каталога' }]]) }, 1);
    return true;
  }

  if (text === 'Добавить авто в каталог') {
    sess.step = 'admin_veh_cat_name'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите название авто для каталога:', {}, 1);
    return true;
  }
  if (step === 'admin_veh_cat_name') {
    sess.data.vehName = text; sess.step = 'admin_veh_cat_photo'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Пришлите фото авто (или введите «Пропустить»):', { keyboard: msgKb([[{ label: 'Пропустить' }]]) }, 1);
    return true;
  }
  if (step === 'admin_veh_cat_photo') {
    let photoId = null;
    if (text !== 'Пропустить' && event.attachments) {
      const ph = (event.attachments || []).find(a => a.type === 'photo');
      if (ph) photoId = `photo${ph.photo.owner_id}_${ph.photo.id}`;
    }
    const vehicles = readJSON(VEHICLES_FILE, { org_vehicles: [], catalog: [] });
    vehicles.catalog.push({ id: genId(), name: sess.data.vehName, photoId });
    writeJSON(VEHICLES_FILE, vehicles);
    sess.step = null; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, `Авто «${sess.data.vehName}» добавлено в каталог.`, {}, 1);
    return true;
  }

  if (text === 'Добавить авто организации') {
    const vehicles = readJSON(VEHICLES_FILE, { org_vehicles: [], catalog: [] });
    if (!vehicles.catalog.length) { await sendMessage(peerId, 'Сначала добавьте авто в каталог.', {}, 1); return true; }
    sess.step = 'admin_org_veh_select'; storage.adminSessions.set(uid, sess);
    const rows = vehicles.catalog.map(v => [{ label: v.name }]);
    rows.push([{ label: 'Отмена' }]);
    await sendMessage(peerId, 'Выберите авто из каталога для орг. парка:', { keyboard: msgKb(rows) }, 1);
    return true;
  }
  if (step === 'admin_org_veh_select') {
    if (text === 'Отмена') { sess.step = null; storage.adminSessions.set(uid, sess); return true; }
    const vehicles = readJSON(VEHICLES_FILE, { org_vehicles: [], catalog: [] });
    const veh = vehicles.catalog.find(v => v.name === text);
    if (!veh) return true;
    vehicles.org_vehicles.push({ ...veh });
    writeJSON(VEHICLES_FILE, vehicles);
    sess.step = null; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, `Авто «${veh.name}» добавлено в орг. парк.`, {}, 1);
    return true;
  }

  return false;
}

// Vehicle add for staff
async function handleStaffVehicleAdd(uid, peerId, text, event) {
  const sess = storage.staffSessions.get(uid) || { step: null, data: {} };
  const step = sess.step;
  const staff = readJSON(STAFF_FILE, {});
  const profile = staff[uid];

  if (text === 'Добавить личное авто') {
    const vehicles = readJSON(VEHICLES_FILE, { org_vehicles: [], catalog: [] });
    if (!vehicles.catalog.length) { await sendMessage(peerId, 'В каталоге нет авто. Обратитесь к руководству.', {}, 1); return true; }
    sess.step = 'staff_veh_select'; storage.staffSessions.set(uid, sess);
    const rows = vehicles.catalog.map(v => [{ label: v.name }]);
    rows.push([{ label: 'Отмена' }]);
    await sendMessage(peerId, 'Выберите авто из каталога:', { keyboard: msgKb(rows) }, 1);
    return true;
  }
  if (step === 'staff_veh_select') {
    if (text === 'Отмена') { sess.step = null; storage.staffSessions.set(uid, sess); return true; }
    const vehicles = readJSON(VEHICLES_FILE, { org_vehicles: [], catalog: [] });
    const veh = vehicles.catalog.find(v => v.name === text);
    if (!veh) return true;
    sess.data.vehName = veh.name;
    sess.step = 'staff_veh_brandcolor'; storage.staffSessions.set(uid, sess);
    await sendMessage(peerId, `Является ли «${veh.name}» автомобилем в цветах организации?`, { keyboard: msgKb([[{ label: 'Да', color: 'positive' }, { label: 'Нет', color: 'negative' }]]) }, 1);
    return true;
  }
  if (step === 'staff_veh_brandcolor') {
    if (text !== 'Да' && text !== 'Нет') return true;
    sess.data.brandColor = text === 'Да';
    sess.step = 'staff_veh_photo'; storage.staffSessions.set(uid, sess);
    await sendMessage(peerId, 'Пришлите фото вашего авто:', { keyboard: msgKb([[{ label: 'Пропустить' }]]) }, 1);
    return true;
  }
  if (step === 'staff_veh_photo') {
    let photoId = null;
    if (text !== 'Пропустить' && event && event.attachments) {
      const ph = (event.attachments || []).find(a => a.type === 'photo');
      if (ph) photoId = `photo${ph.photo.owner_id}_${ph.photo.id}`;
    }
    if (!profile.vehicles) profile.vehicles = [];
    profile.vehicles.push({ id: genId(), name: sess.data.vehName, brandColor: sess.data.brandColor, photoId, personal: true });
    writeJSON(STAFF_FILE, staff);
    sess.step = null; storage.staffSessions.set(uid, sess);
    await sendMessage(peerId, `Авто «${sess.data.vehName}» добавлено в ваш парк.`, {}, 1);
    return true;
  }

  if (text === 'Взять авто организации') {
    const vehicles = readJSON(VEHICLES_FILE, { org_vehicles: [], catalog: [] });
    if (!vehicles.org_vehicles.length) { await sendMessage(peerId, 'В орг. парке нет авто.', {}, 1); return true; }
    sess.step = 'staff_org_veh_select'; storage.staffSessions.set(uid, sess);
    const rows = vehicles.org_vehicles.map(v => [{ label: v.name }]);
    rows.push([{ label: 'Отмена' }]);
    await sendMessage(peerId, 'Выберите авто организации:', { keyboard: msgKb(rows) }, 1);
    return true;
  }
  if (step === 'staff_org_veh_select') {
    if (text === 'Отмена') { sess.step = null; storage.staffSessions.set(uid, sess); return true; }
    const vehicles = readJSON(VEHICLES_FILE, { org_vehicles: [], catalog: [] });
    const veh = vehicles.org_vehicles.find(v => v.name === text);
    if (!veh) return true;
    if (!profile.orgVehicles) profile.orgVehicles = [];
    profile.orgVehicles.push({ ...veh });
    writeJSON(STAFF_FILE, staff);
    sess.step = null; storage.staffSessions.set(uid, sess);
    await sendMessage(peerId, `Авто организации «${veh.name}» добавлено.`, {}, 1);
    return true;
  }

  if (text === 'Удалить авто') {
    const allCars = [...(profile.vehicles || []).map(v => ({ ...v, src: 'personal' })), ...(profile.orgVehicles || []).map(v => ({ ...v, src: 'org' }))];
    if (!allCars.length) { await sendMessage(peerId, 'Нет авто для удаления.', {}, 1); return true; }
    sess.step = 'staff_veh_delete'; storage.staffSessions.set(uid, sess);
    const rows = allCars.map(v => [{ label: v.name + (v.src === 'org' ? ' [орг]' : '') }]);
    rows.push([{ label: 'Отмена' }]);
    await sendMessage(peerId, 'Выберите авто для удаления:', { keyboard: msgKb(rows) }, 1);
    return true;
  }
  if (step === 'staff_veh_delete') {
    if (text === 'Отмена') { sess.step = null; storage.staffSessions.set(uid, sess); return true; }
    const name = text.replace(' [орг]', '');
    profile.vehicles    = (profile.vehicles || []).filter(v => v.name !== name);
    profile.orgVehicles = (profile.orgVehicles || []).filter(v => v.name !== name);
    writeJSON(STAFF_FILE, staff);
    sess.step = null; storage.staffSessions.set(uid, sess);
    await sendMessage(peerId, `Авто «${name}» удалено.`, {}, 1);
    return true;
  }

  return false;
}

// ─────────────────────────── CATALOGUE ADMIN ──────────────────
async function handleAdminCommand(uid, peerId, text, role) {
  const asSess = storage.adminSessions.get(uid) || { step: null, data: {} };
  storage.adminSessions.set(uid, asSess);

  if (text === 'Управление каталогом') {
    const cat = loadCatalogue();
    const catsText  = cat.categories.map(c => `• ${c.name} (${cat.items.filter(i=>i.categoryId===c.id).length} тов.)`).join('\n') || '(нет)';
    const setsText  = cat.sets.map(s => `• ${s.name} | ${s.price}р.`).join('\n') || '(нет)';
    await sendMessage(peerId,
      `Управление каталогом:\n\nКатегории:\n${catsText}\n\nСеты:\n${setsText}`,
      { keyboard: msgKb([
          [{ label: 'Добавить категорию' }, { label: 'Добавить товар' }],
          [{ label: 'Добавить сет' }, { label: 'Удалить категорию' }],
          [{ label: 'Удалить товар' }, { label: 'Удалить сет' }],
        ]) }, 1);
    return;
  }

  // Dispatch to admin catalogue session handler
  await handleAdminCatalogueSession(uid, peerId, text, null);
}

async function handleAdminCatalogueSession(uid, peerId, text, event) {
  const sess = storage.adminSessions.get(uid) || { step: null, data: {} };
  const step = sess.step;

  // ─ Add Category ─────────────────────────────────────────
  if (text === 'Добавить категорию') {
    sess.step = 'admin_cat_name'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите название новой категории:', {}, 1);
    return true;
  }
  if (step === 'admin_cat_name') {
    const cat = loadCatalogue();
    cat.categories.push({ id: genId(), name: text, items: [] });
    saveCatalogue(cat);
    sess.step = null; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, `Категория «${text}» добавлена.`, {}, 1);
    return true;
  }

  // ─ Add Item ─────────────────────────────────────────────
  if (text === 'Добавить товар') {
    const cat = loadCatalogue();
    if (!cat.categories.length) { await sendMessage(peerId, 'Сначала добавьте категорию.', {}, 1); return true; }
    sess.step = 'admin_item_cat'; storage.adminSessions.set(uid, sess);
    const rows = cat.categories.map(c => [{ label: c.name }]);
    rows.push([{ label: 'Отмена' }]);
    await sendMessage(peerId, 'Выберите категорию для товара:', { keyboard: msgKb(rows) }, 1);
    return true;
  }
  if (step === 'admin_item_cat') {
    if (text === 'Отмена') { sess.step = null; return true; }
    const cat = loadCatalogue();
    const category = cat.categories.find(c => c.name === text);
    if (!category) return true;
    sess.data.itemCatId = category.id; sess.step = 'admin_item_name'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите название товара:', {}, 1);
    return true;
  }
  if (step === 'admin_item_name') {
    sess.data.itemName = text; sess.step = 'admin_item_price'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите стоимость товара (для клиентов, в рублях):', {}, 1);
    return true;
  }
  if (step === 'admin_item_price') {
    sess.data.itemPrice = parseInt(text) || 0; sess.step = 'admin_item_cost'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите себестоимость товара (для расчётов, в рублях):', {}, 1);
    return true;
  }
  if (step === 'admin_item_cost') {
    sess.data.itemCost = parseInt(text) || 0; sess.step = 'admin_item_temp'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Температура / тип (например «80°с») или «Пропустить»:', { keyboard: msgKb([[{ label: 'Пропустить' }]]) }, 1);
    return true;
  }
  if (step === 'admin_item_temp') {
    sess.data.itemTemp = text === 'Пропустить' ? '' : text;
    sess.step = 'admin_item_subitems'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите простые товары из которых состоит (формат: «Яйцо x2, Молоко x1») или «Пропустить»:', { keyboard: msgKb([[{ label: 'Пропустить' }]]) }, 1);
    return true;
  }
  if (step === 'admin_item_subitems') {
    let subItems = [];
    if (text !== 'Пропустить') {
      subItems = text.split(',').map(s => {
        const m = s.trim().match(/^(.+)\s+x(\d+)$/i);
        return m ? { name: m[1].trim(), qty: parseInt(m[2]) } : null;
      }).filter(Boolean);
    }
    sess.data.subItems = subItems; sess.step = 'admin_item_instruction'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Пришлите фото-инструкцию для курьера (или «Пропустить»):', { keyboard: msgKb([[{ label: 'Пропустить' }]]) }, 1);
    return true;
  }
  if (step === 'admin_item_instruction') {
    let photoId = null;
    if (text !== 'Пропустить' && event && event.attachments) {
      const ph = (event.attachments || []).find(a => a.type === 'photo');
      if (ph) photoId = `photo${ph.photo.owner_id}_${ph.photo.id}`;
    }
    sess.data.instruction = photoId; sess.step = 'admin_item_photo'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Пришлите фото товара для каталога (или «Пропустить»):', { keyboard: msgKb([[{ label: 'Пропустить' }]]) }, 1);
    return true;
  }
  if (step === 'admin_item_photo') {
    let photoId = null;
    if (text !== 'Пропустить' && event && event.attachments) {
      const ph = (event.attachments || []).find(a => a.type === 'photo');
      if (ph) photoId = `photo${ph.photo.owner_id}_${ph.photo.id}`;
    }
    const cat = loadCatalogue();
    const newItem = {
      id: genId(),
      name:       sess.data.itemName,
      price:      sess.data.itemPrice,
      cost:       sess.data.itemCost,
      temp:       sess.data.itemTemp || '',
      categoryId: sess.data.itemCatId,
      subItems:   sess.data.subItems || [],
      instruction: sess.data.instruction || null,
      photoId:    photoId,
    };
    cat.items.push(newItem);
    saveCatalogue(cat);
    sess.step = null; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, `Товар «${newItem.name}» добавлен (${newItem.price}р. / себест. ${newItem.cost}р.).`, {}, 1);
    return true;
  }

  // ─ Add Set ──────────────────────────────────────────────
  if (text === 'Добавить сет') {
    sess.step = 'admin_set_name'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите название сета:', {}, 1);
    return true;
  }
  if (step === 'admin_set_name') {
    sess.data.setName = text; sess.step = 'admin_set_price'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите стоимость сета (для клиентов):', {}, 1);
    return true;
  }
  if (step === 'admin_set_price') {
    sess.data.setPrice = parseInt(text) || 0; sess.step = 'admin_set_cost'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите себестоимость сета:', {}, 1);
    return true;
  }
  if (step === 'admin_set_cost') {
    sess.data.setCost = parseInt(text) || 0; sess.step = 'admin_set_items'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите товары сета (формат: «Бургер x1, Вода x1»):', {}, 1);
    return true;
  }
  if (step === 'admin_set_items') {
    const subItems = text.split(',').map(s => {
      const m = s.trim().match(/^(.+)\s+x(\d+)$/i);
      return m ? { name: m[1].trim(), qty: parseInt(m[2]) } : null;
    }).filter(Boolean);
    sess.data.setItems = subItems; sess.step = 'admin_set_photo'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Пришлите фото сета или «Пропустить»:', { keyboard: msgKb([[{ label: 'Пропустить' }]]) }, 1);
    return true;
  }
  if (step === 'admin_set_photo') {
    let photoId = null;
    if (text !== 'Пропустить' && event && event.attachments) {
      const ph = (event.attachments || []).find(a => a.type === 'photo');
      if (ph) photoId = `photo${ph.photo.owner_id}_${ph.photo.id}`;
    }
    const cat = loadCatalogue();
    cat.sets.push({
      id: genId(), name: sess.data.setName,
      price: sess.data.setPrice, cost: sess.data.setCost,
      subItems: sess.data.setItems, photoId,
    });
    saveCatalogue(cat);
    sess.step = null; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, `Сет «${sess.data.setName}» добавлен.`, {}, 1);
    return true;
  }

  // ─ Delete Category ──────────────────────────────────────
  if (text === 'Удалить категорию') {
    const cat = loadCatalogue();
    const rows = cat.categories.filter(c => c.id !== 'sets').map(c => [{ label: c.name }]);
    rows.push([{ label: 'Отмена' }]);
    sess.step = 'admin_del_cat'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Выберите категорию для удаления:', { keyboard: msgKb(rows) }, 1);
    return true;
  }
  if (step === 'admin_del_cat') {
    if (text === 'Отмена') { sess.step = null; return true; }
    const cat = loadCatalogue();
    const idx = cat.categories.findIndex(c => c.name === text);
    if (idx !== -1) {
      cat.items = cat.items.filter(it => it.categoryId !== cat.categories[idx].id);
      cat.categories.splice(idx, 1);
      saveCatalogue(cat);
    }
    sess.step = null;
    await sendMessage(peerId, `Категория «${text}» и все её товары удалены.`, {}, 1);
    return true;
  }

  // ─ Delete Item ──────────────────────────────────────────
  if (text === 'Удалить товар') {
    sess.step = 'admin_del_item_name'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите название товара для удаления:', {}, 1);
    return true;
  }
  if (step === 'admin_del_item_name') {
    const cat = loadCatalogue();
    const before = cat.items.length;
    cat.items = cat.items.filter(it => it.name !== text);
    saveCatalogue(cat);
    sess.step = null;
    await sendMessage(peerId, before !== cat.items.length ? `Товар «${text}» удалён.` : `Товар «${text}» не найден.`, {}, 1);
    return true;
  }

  // ─ Delete Set ───────────────────────────────────────────
  if (text === 'Удалить сет') {
    sess.step = 'admin_del_set_name'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите название сета для удаления:', {}, 1);
    return true;
  }
  if (step === 'admin_del_set_name') {
    const cat = loadCatalogue();
    const before = cat.sets.length;
    cat.sets = cat.sets.filter(s => s.name !== text);
    saveCatalogue(cat);
    sess.step = null;
    await sendMessage(peerId, before !== cat.sets.length ? `Сет «${text}» удалён.` : `Сет «${text}» не найден.`, {}, 1);
    return true;
  }

  return false;
}

// ─────────────────────────── PROMO ADMIN ─────────────────────
async function handleAdminPromosSession(uid, peerId, text, event, role) {
  const sess = storage.adminSessions.get(uid) || { step: null, data: {} };
  const step = sess.step;

  if (text === 'Управление промокодами') {
    const promos = readJSON(PROMOS_FILE, { delivery: [], taxi: [] });
    const delText  = promos.delivery.map(p => `• ${p.code} | ${p.type} | ${p.active ? 'активен' : 'неакт.'}`).join('\n') || '(нет)';
    const taxiText = promos.taxi.map(p => `• ${p.code} | ${p.type} | ${p.active ? 'активен' : 'неакт.'}`).join('\n') || '(нет)';
    await sendMessage(peerId,
      `Промокоды:\n\nДоставка:\n${delText}\n\nТакси:\n${taxiText}`,
      { keyboard: msgKb([[{ label: 'Добавить промокод доставки' }, { label: 'Добавить промокод такси' }], [{ label: 'Удалить промокод' }, { label: 'Деактивировать промокод' }]]) }, 1);
    return true;
  }

  if (text === 'Добавить промокод доставки' || text === 'Добавить промокод такси') {
    sess.data.promoService = text.includes('такси') ? 'taxi' : 'delivery';
    sess.step = 'admin_promo_code'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите код промокода:', {}, 1);
    return true;
  }
  if (step === 'admin_promo_code') {
    sess.data.promoCode = text.toUpperCase(); sess.step = 'admin_promo_type'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Выберите тип промокода:', { keyboard: msgKb([
      [{ label: 'Скидка %' }, { label: 'Скидка фикс.' }],
      [{ label: 'Бесплатный товар' }, { label: 'Бесплатная доставка' }],
      [{ label: 'Скидка на категорию' }],
    ]) }, 1);
    return true;
  }
  if (step === 'admin_promo_type') {
    const typeMap = { 'Скидка %': 'percent', 'Скидка фикс.': 'fixed', 'Бесплатный товар': 'free_item', 'Бесплатная доставка': 'free_delivery', 'Скидка на категорию': 'category_discount' };
    if (!typeMap[text]) return true;
    sess.data.promoType = typeMap[text];
    if (sess.data.promoType === 'free_delivery') {
      await saveNewPromo(uid, peerId, sess, {});
      return true;
    }
    if (sess.data.promoType === 'free_item') {
      sess.step = 'admin_promo_item_name'; storage.adminSessions.set(uid, sess);
      await sendMessage(peerId, 'Введите название бесплатного товара:', {}, 1);
      return true;
    }
    if (sess.data.promoType === 'category_discount') {
      sess.step = 'admin_promo_cat'; storage.adminSessions.set(uid, sess);
      const cat = loadCatalogue();
      const rows = cat.categories.map(c => [{ label: c.name }]);
      await sendMessage(peerId, 'Выберите категорию:', { keyboard: msgKb(rows) }, 1);
      return true;
    }
    sess.step = 'admin_promo_value'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите значение скидки (число):', {}, 1);
    return true;
  }
  if (step === 'admin_promo_item_name') {
    sess.data.promoItemName = text; sess.step = 'admin_promo_item_save'; storage.adminSessions.set(uid, sess);
    await saveNewPromo(uid, peerId, sess, { itemName: text }); return true;
  }
  if (step === 'admin_promo_cat') {
    sess.data.promoCatName = text; sess.step = 'admin_promo_value'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите процент скидки на категорию:', {}, 1);
    return true;
  }
  if (step === 'admin_promo_value') {
    const val = parseFloat(text) || 0;
    const extra = sess.data.promoCatName ? { categoryName: sess.data.promoCatName, value: val } : { value: val };
    await saveNewPromo(uid, peerId, sess, extra);
    return true;
  }

  if (text === 'Удалить промокод' || text === 'Деактивировать промокод') {
    sess.data.promoAction = text === 'Удалить промокод' ? 'delete' : 'deactivate';
    sess.step = 'admin_promo_action_code'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите код промокода:', {}, 1);
    return true;
  }
  if (step === 'admin_promo_action_code') {
    const promos = readJSON(PROMOS_FILE, { delivery: [], taxi: [] });
    const code = text.toUpperCase();
    let found = false;
    for (const svc of ['delivery', 'taxi']) {
      const idx = promos[svc].findIndex(p => p.code === code);
      if (idx !== -1) {
        found = true;
        if (sess.data.promoAction === 'delete') promos[svc].splice(idx, 1);
        else promos[svc][idx].active = false;
      }
    }
    writeJSON(PROMOS_FILE, promos);
    sess.step = null; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, found ? `Промокод «${code}» ${sess.data.promoAction === 'delete' ? 'удалён' : 'деактивирован'}.` : 'Промокод не найден.', {}, 1);
    return true;
  }

  return false;
}

async function saveNewPromo(uid, peerId, sess, extra) {
  const promos = readJSON(PROMOS_FILE, { delivery: [], taxi: [] });
  const newPromo = {
    id: genId(), code: sess.data.promoCode,
    type: sess.data.promoType, active: true,
    createdAt: Date.now(), ...extra,
  };
  promos[sess.data.promoService].push(newPromo);
  writeJSON(PROMOS_FILE, promos);
  sess.step = null; storage.adminSessions.set(uid, sess);
  await sendMessage(peerId, `Промокод «${newPromo.code}» создан (${newPromo.type}).`, {}, 1);
}

// ─────────────────────────── TAXI: GROUP 3 DMs ────────────────
const TAXI_STEP = {
  MAIN:           'taxi_main',
  ORDER_NICK:     'taxi_nick',
  ORDER_PASSENGERS: 'taxi_passengers',
  ORDER_FROM_CAT: 'taxi_from_cat',
  ORDER_FROM:     'taxi_from',
  ORDER_TO_CAT:   'taxi_to_cat',
  ORDER_TO:       'taxi_to',
  ORDER_PROMO:    'taxi_promo',
  ORDER_PAYMENT:  'taxi_payment',
  ORDER_PAYMENT_SCREEN: 'taxi_payment_screen',
  ORDER_CONFIRM:  'taxi_confirm',
  WAITING:        'taxi_waiting',
  ACTIVE:         'taxi_active',
};

function taxiSession(uid) {
  if (!storage.clientSessions.has('taxi_'+uid)) {
    storage.clientSessions.set('taxi_'+uid, { step: TAXI_STEP.MAIN, data: {} });
  }
  return storage.clientSessions.get('taxi_'+uid);
}

async function handleTaxiDM(event) {
  const uid    = event.from_id;
  const text   = (event.text || '').trim();
  const peerId = event.peer_id;
  const sess   = taxiSession(uid);

  // Check for admin promo management in group 3
  const role = await getUserRole(uid);
  if (role === 'rs' || role === 'ss') {
    const handled = await handleTaxiAdminPromos(uid, peerId, text, event);
    if (handled) return;
  }

  // Main menu
  if (text === 'начать' || text === '/start') {
    sess.step = TAXI_STEP.MAIN;
    await sendMessage(peerId, 'Сервис такси. Выберите раздел:', { keyboard: msgKb([
      [{ label: 'Заказать такси', color: 'positive' }],
      [{ label: 'Трудоустройство', color: 'secondary' }, { label: 'Частые вопросы', color: 'secondary' }],
    ]) }, 3);
    return;
  }
  if (text === 'Главное меню') {
    sess.step = TAXI_STEP.MAIN; sess.data = {};
    await sendMessage(peerId, 'Главное меню:', { keyboard: msgKb([
      [{ label: 'Заказать такси', color: 'positive' }],
      [{ label: 'Трудоустройство', color: 'secondary' }, { label: 'Частые вопросы', color: 'secondary' }],
    ]) }, 3);
    return;
  }
  if (text === 'Трудоустройство') {
    await sendMessage(peerId, 'Для трудоустройства обратитесь к администратору.', { keyboard: msgKb([[{ label: 'Главное меню', color: 'secondary' }]]) }, 3);
    return;
  }
  if (text === 'Частые вопросы') {
    await sendMessage(peerId, 'FAQ такси:\n\n❓ Как рассчитывается цена?\nПо карте маршрута с учётом спроса.\n\n❓ Можно добавить попутчика?\nДа, до 2 попутчиков.\n\n❓ Комиссия за оплату?\nНаличные — 0%, счёт телефона — 7%, банковский счёт — 5%.', { keyboard: msgKb([[{ label: 'Главное меню', color: 'secondary' }]]) }, 3);
    return;
  }

  if (text === 'Заказать такси' || sess.step === TAXI_STEP.MAIN) {
    if (text !== 'Заказать такси' && sess.step === TAXI_STEP.MAIN) return;
    sess.step = TAXI_STEP.ORDER_NICK; sess.data = {};
    storage.clientSessions.set('taxi_'+uid, sess);
    await sendMessage(peerId, 'Введите ваш никнейм:', { keyboard: msgKb([[{ label: 'Отмена', color: 'negative' }]]) }, 3);
    return;
  }

  if (sess.step === TAXI_STEP.ORDER_NICK) {
    if (text === 'Отмена') { sess.step = TAXI_STEP.MAIN; return; }
    sess.data.nick = text; sess.step = TAXI_STEP.ORDER_PASSENGERS;
    storage.clientSessions.set('taxi_'+uid, sess);
    await sendMessage(peerId, 'Добавить попутчиков? (до 2 чел., введите ники через запятую или «Пропустить»):', { keyboard: msgKb([[{ label: 'Пропустить', color: 'secondary' }], [{ label: 'Отмена', color: 'negative' }]]) }, 3);
    return;
  }

  if (sess.step === TAXI_STEP.ORDER_PASSENGERS) {
    if (text === 'Отмена') { sess.step = TAXI_STEP.MAIN; return; }
    if (text !== 'Пропустить') {
      const passengers = text.split(',').map(s => s.trim()).slice(0, 2);
      sess.data.passengers = passengers;
    } else {
      sess.data.passengers = [];
    }
    sess.step = TAXI_STEP.ORDER_FROM_CAT;
    storage.clientSessions.set('taxi_'+uid, sess);
    await showTaxiPointCats(peerId, 'Откуда:', uid, 3);
    return;
  }

  if (sess.step === TAXI_STEP.ORDER_FROM_CAT) {
    if (text === 'Отмена') { sess.step = TAXI_STEP.MAIN; return; }
    const tp = readJSON(TAXI_POINTS_FILE, { categories: [], points: [] });
    const cat = tp.categories.find(c => c.name === text);
    if (!cat) return;
    sess.data.fromCat = cat.id; sess.step = TAXI_STEP.ORDER_FROM;
    storage.clientSessions.set('taxi_'+uid, sess);
    const points = tp.points.filter(p => p.categoryId === cat.id);
    const rows = points.map(p => [{ label: p.name }]);
    rows.push([{ label: '← Назад' }, { label: 'Отмена', color: 'negative' }]);
    await sendMessage(peerId, `Откуда (категория: ${cat.name}):`, { keyboard: msgKb(rows) }, 3);
    return;
  }

  if (sess.step === TAXI_STEP.ORDER_FROM) {
    if (text === 'Отмена') { sess.step = TAXI_STEP.MAIN; return; }
    if (text === '← Назад') { sess.step = TAXI_STEP.ORDER_FROM_CAT; await showTaxiPointCats(peerId, 'Откуда:', uid, 3); return; }
    const tp = readJSON(TAXI_POINTS_FILE, { categories: [], points: [] });
    const point = tp.points.find(p => p.name === text);
    if (!point) return;
    sess.data.from = point; sess.step = TAXI_STEP.ORDER_TO_CAT;
    storage.clientSessions.set('taxi_'+uid, sess);
    await showTaxiPointCats(peerId, 'Куда:', uid, 3);
    return;
  }

  if (sess.step === TAXI_STEP.ORDER_TO_CAT) {
    if (text === 'Отмена') { sess.step = TAXI_STEP.MAIN; return; }
    const tp = readJSON(TAXI_POINTS_FILE, { categories: [], points: [] });
    const cat = tp.categories.find(c => c.name === text);
    if (!cat) return;
    sess.data.toCat = cat.id; sess.step = TAXI_STEP.ORDER_TO;
    storage.clientSessions.set('taxi_'+uid, sess);
    const points = tp.points.filter(p => p.categoryId === cat.id);
    const rows = points.map(p => [{ label: p.name }]);
    rows.push([{ label: '← Назад' }, { label: 'Отмена', color: 'negative' }]);
    await sendMessage(peerId, `Куда (категория: ${cat.name}):`, { keyboard: msgKb(rows) }, 3);
    return;
  }

  if (sess.step === TAXI_STEP.ORDER_TO) {
    if (text === 'Отмена') { sess.step = TAXI_STEP.MAIN; return; }
    if (text === '← Назад') { sess.step = TAXI_STEP.ORDER_TO_CAT; await showTaxiPointCats(peerId, 'Куда:', uid, 3); return; }
    const tp = readJSON(TAXI_POINTS_FILE, { categories: [], points: [] });
    const point = tp.points.find(p => p.name === text);
    if (!point) return;
    sess.data.to = point;
    // Calculate price
    const price = calculateTaxiPrice(sess.data.from, sess.data.to);
    sess.data.basePrice = price;
    sess.step = TAXI_STEP.ORDER_PROMO;
    storage.clientSessions.set('taxi_'+uid, sess);
    await sendMessage(peerId,
      `Маршрут: ${sess.data.from.name} → ${sess.data.to.name}\nПримерная стоимость: ${price}р.\n\nЕсть промокод? Введите или «Пропустить»:`,
      { keyboard: msgKb([[{ label: 'Пропустить', color: 'secondary' }], [{ label: 'Отмена', color: 'negative' }]]) }, 3);
    return;
  }

  if (sess.step === TAXI_STEP.ORDER_PROMO) {
    if (text === 'Отмена') { sess.step = TAXI_STEP.MAIN; return; }
    if (text !== 'Пропустить') {
      const pr = applyPromo(text, 'taxi', [{ name: 'Поездка', price: sess.data.basePrice, qty: 1 }]);
      if (!pr.ok) {
        await sendMessage(peerId, pr.msg + '\nВведите другой промокод или «Пропустить»:', { keyboard: msgKb([[{ label: 'Пропустить' }]]) }, 3);
        return;
      }
      sess.data.promo = pr;
      sess.data.discountedPrice = Math.max(0, sess.data.basePrice - (pr.discount || 0));
    } else {
      sess.data.discountedPrice = sess.data.basePrice;
    }
    sess.step = TAXI_STEP.ORDER_PAYMENT;
    storage.clientSessions.set('taxi_'+uid, sess);
    await sendMessage(peerId,
      `Стоимость: ${sess.data.discountedPrice}р.\n\nВыберите способ оплаты:\n• Наличными — без комиссии\n• Счёт телефона — +7% комиссия\n• Банк. счёт — +5% комиссия`,
      { keyboard: msgKb([[{ label: 'Наличными' }], [{ label: 'Счёт телефона' }], [{ label: 'Банковский счёт' }], [{ label: 'Отмена', color: 'negative' }]]) }, 3);
    return;
  }

  if (sess.step === TAXI_STEP.ORDER_PAYMENT) {
    if (text === 'Отмена') { sess.step = TAXI_STEP.MAIN; return; }
    const payMap = { 'Наличными': { type: 'cash', commission: 0 }, 'Счёт телефона': { type: 'phone', commission: 0.07 }, 'Банковский счёт': { type: 'bank', commission: 0.05 } };
    const pay = payMap[text];
    if (!pay) return;
    sess.data.payment = pay;
    const finalPrice = Math.round(sess.data.discountedPrice * (1 + pay.commission));
    sess.data.finalPrice = finalPrice;

    if (pay.type !== 'cash') {
      sess.step = TAXI_STEP.ORDER_PAYMENT_SCREEN;
      storage.clientSessions.set('taxi_'+uid, sess);
      await sendMessage(peerId,
        `Итоговая сумма (с комиссией ${Math.round(pay.commission*100)}%): ${finalPrice}р.\n\nПереведите средства на счёт ${ORG_BANK} и пришлите скриншот оплаты с /timestamp или временем над HUD.`,
        { keyboard: msgKb([[{ label: 'Отмена', color: 'negative' }]]) }, 3);
      return;
    }

    sess.step = TAXI_STEP.ORDER_CONFIRM;
    storage.clientSessions.set('taxi_'+uid, sess);
    await showTaxiConfirm(peerId, uid, sess, 3);
    return;
  }

  if (sess.step === TAXI_STEP.ORDER_PAYMENT_SCREEN) {
    if (text === 'Отмена') { sess.step = TAXI_STEP.MAIN; return; }
    // Accept screenshot
    const hasScreenshot = event.attachments && event.attachments.some(a => a.type === 'photo');
    if (!hasScreenshot && !text.includes('/timestamp')) {
      await sendMessage(peerId, 'Пришлите скриншот оплаты с /timestamp или временем над HUD.', {}, 3);
      return;
    }
    sess.data.paymentScreenshot = true;
    sess.step = TAXI_STEP.ORDER_CONFIRM;
    storage.clientSessions.set('taxi_'+uid, sess);
    await showTaxiConfirm(peerId, uid, sess, 3);
    return;
  }

  if (sess.step === TAXI_STEP.ORDER_CONFIRM) {
    if (text === 'Изменить') { sess.step = TAXI_STEP.ORDER_NICK; await sendMessage(peerId, 'Введите никнейм:', {}, 3); return; }
    if (text === 'Подтвердить') {
      const orderId = genId();
      const order = {
        id: orderId, type: 'taxi', clientId: uid,
        nick: sess.data.nick,
        passengers: sess.data.passengers || [],
        from: sess.data.from, to: sess.data.to,
        basePrice: sess.data.basePrice, finalPrice: sess.data.finalPrice,
        payment: sess.data.payment,
        promo: sess.data.promo?.promo?.code || null,
        promoDesc: sess.data.promo?.msg || null,
        status: 'pending', createdAt: Date.now(),
      };
      storage.activeTaxi.set(orderId, order);

      const ords = readJSON(ORDERS_FILE, { delivery: [], taxi: [] });
      ords.taxi.push(order);
      writeJSON(ORDERS_FILE, ords);

      await sendOrderToDispatch(order);

      sess.step = TAXI_STEP.WAITING; sess.data.orderId = orderId;
      storage.clientSessions.set('taxi_'+uid, sess);
      await sendMessage(peerId,
        'Заказ такси оформлен! Ожидайте назначения водителя.',
        { keyboard: msgKb([[{ label: 'Статус заказа' }], [{ label: 'Главное меню', color: 'secondary' }]]) }, 3);
      return;
    }
    return;
  }

  if (sess.step === TAXI_STEP.WAITING || sess.step === TAXI_STEP.ACTIVE) {
    if (text === 'Статус заказа') {
      const order = storage.activeTaxi.get(sess.data.orderId);
      if (!order) { await sendMessage(peerId, 'Заказ не найден или завершён.', {}, 3); return; }
      const statusMap = { pending: 'Ожидает водителя', accepted: 'Водитель едет к вам', delivering: 'В пути', arrived: 'Водитель ждёт', done: 'Завершён' };
      await sendMessage(peerId, `Статус: ${statusMap[order.status] || order.status}\nВодитель: ${order.courierNick || 'не назначен'}`, {}, 3);
      return;
    }
    if (text === 'Главное меню') { sess.step = TAXI_STEP.MAIN; sess.data = {}; return; }
    return;
  }
}

async function showTaxiPointCats(peerId, prompt, uid, groupKey) {
  const tp = readJSON(TAXI_POINTS_FILE, { categories: [], points: [] });
  if (!tp.categories.length) { await sendMessage(peerId, 'Точки маршрута пока не добавлены. Обратитесь к администратору.', {}, groupKey); return; }
  const rows = tp.categories.map(c => [{ label: c.name }]);
  rows.push([{ label: 'Отмена', color: 'negative' }]);
  await sendMessage(peerId, prompt, { keyboard: msgKb(rows) }, groupKey);
}

async function showTaxiConfirm(peerId, uid, sess, groupKey) {
  const passText = sess.data.passengers?.length ? `\nПопутчики: ${sess.data.passengers.join(', ')}` : '';
  const payText  = sess.data.payment.type === 'cash' ? 'Наличными' : sess.data.payment.type === 'phone' ? 'Счёт телефона' : 'Банковский счёт';
  const promoText = sess.data.promoDesc ? `\nПромокод: ${sess.data.promoDesc}` : '';
  await sendMessage(peerId,
    `Проверьте заказ:\n\nНик: ${sess.data.nick}${passText}\nОткуда: ${sess.data.from.name}\nКуда: ${sess.data.to.name}\nОплата: ${payText}\nСтоимость: ${sess.data.finalPrice}р.${promoText}\n\nВсё верно?`,
    { keyboard: msgKb([[{ label: 'Подтвердить', color: 'positive' }, { label: 'Изменить', color: 'secondary' }]]) }, groupKey);
}

function calculateTaxiPrice(from, to) {
  // Use stored distance or default formula
  if (from.priceOverrides && from.priceOverrides[to.id]) return from.priceOverrides[to.id];
  // Simple distance-based: each point has optional coords (x,y from map)
  if (from.x !== undefined && to.x !== undefined) {
    const dist = Math.sqrt(Math.pow(from.x - to.x, 2) + Math.pow(from.y - to.y, 2));
    const base = Math.round(dist * 50); // 50р per unit
    // Peak hour multiplier (18-22 MSK)
    const hour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).getHours();
    const peak = (hour >= 18 && hour <= 22) ? 1.3 : 1.0;
    return Math.round(base * peak);
  }
  return from.defaultPrice || 500;
}

async function handleTaxiAdminPromos(uid, peerId, text, event) {
  const sess = storage.adminSessions.get(uid) || { step: null, data: {} };
  const step = sess.step;

  if (text === 'Добавить промокод такси' || text === 'Управление промокодами такси') {
    sess.data.promoService = 'taxi'; sess.step = 'admin_promo_code';
    storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите код промокода:', {}, 3);
    return true;
  }
  // Reuse general promo session
  return handleAdminPromosSession(uid, peerId, text, event, 'rs');
}

// ─────────────────────────── TAXI: POINT MANAGEMENT (group 1 DM) ──
async function handleTaxiPointAdmin(uid, peerId, text, event) {
  const sess = storage.adminSessions.get(uid) || { step: null, data: {} };
  const step = sess.step;

  if (text === 'Управление точками такси') {
    const tp = readJSON(TAXI_POINTS_FILE, { categories: [], points: [] });
    const cats  = tp.categories.map(c => `• ${c.name} (${tp.points.filter(p => p.categoryId === c.id).length} точек)`).join('\n') || '(нет)';
    await sendMessage(peerId,
      `Точки такси:\n\nКатегории:\n${cats}`,
      { keyboard: msgKb([[{ label: 'Добавить категорию точек' }, { label: 'Добавить точку' }], [{ label: 'Удалить точку' }]]) }, 1);
    return true;
  }

  if (text === 'Добавить катег��рию точек') {
    sess.step = 'taxi_pt_cat_name'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите название категории точек (напр. «Авто», «Гос. учреждения»):', {}, 1);
    return true;
  }
  if (step === 'taxi_pt_cat_name') {
    const tp = readJSON(TAXI_POINTS_FILE, { categories: [], points: [] });
    tp.categories.push({ id: genId(), name: text });
    writeJSON(TAXI_POINTS_FILE, tp);
    sess.step = null; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, `Категория «${text}» добавлена.`, {}, 1);
    return true;
  }

  if (text === 'Добавить точку') {
    const tp = readJSON(TAXI_POINTS_FILE, { categories: [], points: [] });
    if (!tp.categories.length) { await sendMessage(peerId, 'Сначала добавьте категорию.', {}, 1); return true; }
    sess.step = 'taxi_pt_cat'; storage.adminSessions.set(uid, sess);
    const rows = tp.categories.map(c => [{ label: c.name }]);
    rows.push([{ label: 'Новая категория' }, { label: 'Отмена' }]);
    await sendMessage(peerId, 'Выберите категорию для точки:', { keyboard: msgKb(rows) }, 1);
    return true;
  }
  if (step === 'taxi_pt_cat') {
    if (text === 'Отмена') { sess.step = null; return true; }
    if (text === 'Новая категория') { sess.step = 'taxi_pt_cat_name'; storage.adminSessions.set(uid, sess); await sendMessage(peerId, 'Введите название новой категории:', {}, 1); return true; }
    const tp = readJSON(TAXI_POINTS_FILE, { categories: [], points: [] });
    const cat = tp.categories.find(c => c.name === text);
    if (!cat) return true;
    sess.data.ptCatId = cat.id; sess.step = 'taxi_pt_name'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите название точки:', {}, 1);
    return true;
  }
  if (step === 'taxi_pt_name') {
    sess.data.ptName = text; sess.step = 'taxi_pt_price'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите базовую цену от этой точки (в рублях, для ориентира):', {}, 1);
    return true;
  }
  if (step === 'taxi_pt_price') {
    sess.data.ptPrice = parseInt(text) || 500; sess.step = 'taxi_pt_coords'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите координаты точки на карте в формате «X,Y» (целые числа, смотрите map-editor.html) или «Пропустить»:', { keyboard: msgKb([[{ label: 'Пропустить' }]]) }, 1);
    return true;
  }
  if (step === 'taxi_pt_coords') {
    let x, y;
    if (text !== 'Пропустить') {
      const parts = text.split(',').map(s => parseInt(s.trim()));
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) { x = parts[0]; y = parts[1]; }
    }
    const tp = readJSON(TAXI_POINTS_FILE, { categories: [], points: [] });
    tp.points.push({ id: genId(), name: sess.data.ptName, categoryId: sess.data.ptCatId, defaultPrice: sess.data.ptPrice, x, y });
    writeJSON(TAXI_POINTS_FILE, tp);
    sess.step = null; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, `Точка «${sess.data.ptName}» добавлена.`, {}, 1);
    return true;
  }

  if (text === 'Удалить точку') {
    sess.step = 'taxi_pt_del_name'; storage.adminSessions.set(uid, sess);
    await sendMessage(peerId, 'Введите название точки для удаления:', {}, 1);
    return true;
  }
  if (step === 'taxi_pt_del_name') {
    const tp = readJSON(TAXI_POINTS_FILE, { categories: [], points: [] });
    const before = tp.points.length;
    tp.points = tp.points.filter(p => p.name !== text);
    writeJSON(TAXI_POINTS_FILE, tp);
    sess.step = null;
    await sendMessage(peerId, before !== tp.points.length ? `Точка «${text}» удалена.` : `Точка «${text}» не найдена.`, {}, 1);
    return true;
  }

  return false;
}

// ─────────────────────────── ACTIVITY JOURNAL ─────────────────
async function handleJournalMessage(event) {
  const text   = (event.text || '').trim();
  const uid    = event.from_id;
  const peerId = event.peer_id;

  if (!text.startsWith('!')) return;

  const parts  = text.split(' ');
  const cmd    = parts[0].toLowerCase();
  const statusText = parts.slice(1).join(' ');

  const staff = readJSON(STAFF_FILE, {});
  const profile = staff[uid];

  // Determine nick and role
  const nick   = profile?.nick || `id${uid}`;
  const role   = profile?.role || (await getUserRole(uid)) || 'Курьер';
  const roleAbbr = { rs: 'РС', ss: 'СС', kurier: 'Курьер', stazher: 'Стажёр' }[role] || role;

  // Determine org membership
  let orgs = [];
  if (profile?.groups) orgs = profile.groups;
  // Fallback: check chat membership
  if (!orgs.length) {
    try {
      const dm = await callVK('messages.getConversationMembers', { peer_id: CHATS.dispetcherskaya });
      if ((dm.items || []).some(m => m.member_id === uid)) orgs.push('delivery');
    } catch(_) {}
    try {
      const tm = await callVK('messages.getConversationMembers', { peer_id: CHATS.taxiDispetcherskaya });
      if ((tm.items || []).some(m => m.member_id === uid)) orgs.push('taxi');
    } catch(_) {}
  }

  let newStatus, online, afk;

  if (cmd === '!онлайн') {
    online = true; afk = false;
    newStatus = statusText || (role === 'stazher' ? 'экзамен' : 'доставка');
  } else if (cmd === '!афк') {
    online = true; afk = true;
    newStatus = statusText || 'Не у ПК';
  } else if (cmd === '!вышел') {
    online = false; afk = false;
    newStatus = '';
  } else {
    return; // not a journal command
  }

  // Update online map
  const now = Date.now();
  const prev = storage.online.get(uid);
  if (prev && prev.online && !online) {
    // Session ending — accumulate time
    const dur = now - (prev.since || now);
    updateOnlineStats(uid, dur);
  }

  if (online) {
    storage.online.set(uid, { nick, role, roleAbbr, orgs, status: newStatus, afk, online: true, since: now });
  } else {
    storage.online.delete(uid);
  }

  // Persist
  const oj = readJSON(ONLINE_FILE, { sessions: {}, stats: {} });
  if (online) {
    oj.sessions[uid] = { nick, role, roleAbbr, orgs, status: newStatus, afk, online: true, since: now };
  } else {
    delete oj.sessions[uid];
  }
  writeJSON(ONLINE_FILE, oj);

  // Build server list message
  const serverList = buildServerList(nick, online ? (afk ? `${newStatus} (АФК)` : newStatus) : null, online);

  let actionText;
  if (cmd === '!онлайн') actionText = `${nick} в сети. (${newStatus})`;
  else if (cmd === '!афк') actionText = `${nick} — АФК. (${newStatus})`;
  else actionText = `${nick} вышел.`;

  await sendMessage(peerId, `${actionText}\n\n${serverList}`, {}, 1);
}

function buildServerList(triggerNick, triggerStatus, triggerOnline) {
  const onlineList = [];
  storage.online.forEach((info, uid) => {
    onlineList.push(`${info.nick} (${info.roleAbbr}) ${info.status}${info.afk ? ' (АФК)' : ''}`);
  });

  if (!onlineList.length) return 'На сервере:\n(никого нет)';
  return `На сервере:\n${onlineList.join('\n')}`;
}

function updateOnlineStats(uid, durationMs) {
  const oj = readJSON(ONLINE_FILE, { sessions: {}, stats: {} });
  if (!oj.stats[uid]) oj.stats[uid] = { totalMs: 0, sessions: [], weeklyMs: {} };
  oj.stats[uid].totalMs = (oj.stats[uid].totalMs || 0) + durationMs;

  const dayKey = new Date().toISOString().slice(0, 10);
  if (!oj.stats[uid].weeklyMs) oj.stats[uid].weeklyMs = {};
  oj.stats[uid].weeklyMs[dayKey] = (oj.stats[uid].weeklyMs[dayKey] || 0) + durationMs;

  writeJSON(ONLINE_FILE, oj);
}

async function handleStatsCommand(event) {
  const text   = (event.text || '').trim();
  const uid    = event.from_id;
  const peerId = event.peer_id;

  if (text.toLowerCase() !== '!стата') return;

  const oj = readJSON(ONLINE_FILE, { sessions: {}, stats: {} });
  const myStats = oj.stats[uid];
  if (!myStats) { await sendMessage(peerId, 'Статистика не найдена.', {}, 1); return; }

  const totalMs = myStats.totalMs || 0;
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayMs = (myStats.weeklyMs || {})[todayKey] || 0;

  // Week total
  const weekStart = getWeekStart();
  let weekMs = 0;
  for (const [day, ms] of Object.entries(myStats.weeklyMs || {})) {
    if (day >= weekStart) weekMs += ms;
  }

  // Top by online this week
  const weekRanking = buildWeekRanking(weekStart);
  const myRank = weekRanking.findIndex(r => String(r.uid) === String(uid)) + 1;

  // Count messages (approximated — just say N/A if not tracked)
  const msgCount = myStats.msgCount || 0;

  const text2 = `Статистика:\n\nВсего онлайн: ${msToHuman(totalMs)}\nОнлайн сегодня: ${msToHuman(todayMs)}\nОнлайн за неделю: ${msToHuman(weekMs)}\nТоп по онлайну за неделю: ${myRank || '—'} место${msgCount ? `\nКол-во сообщений: ${msgCount}` : ''}`;

  await sendMessage(peerId, text2, {}, 1);
}

function getWeekStart() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const day = d.getDay(); // 0=Sun
  const diff = (day + 6) % 7; // Mon=0
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

function buildWeekRanking(weekStart) {
  const oj = readJSON(ONLINE_FILE, { stats: {} });
  const ranking = [];
  for (const [uid, stats] of Object.entries(oj.stats || {})) {
    let weekMs = 0;
    for (const [day, ms] of Object.entries(stats.weeklyMs || {})) {
      if (day >= weekStart) weekMs += ms;
    }
    if (weekMs > 0) ranking.push({ uid, weekMs });
  }
  ranking.sort((a, b) => b.weekMs - a.weekMs);
  return ranking;
}

function msToHuman(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}ч. ${m}м.`;
  return `${m}м.`;
}

// ─────────────────────────── DAILY/WEEKLY REPORTS ────────────────
async function sendDailyReport() {
  const ords = readJSON(ORDERS_FILE, { delivery: [], taxi: [] });
  const staff = readJSON(STAFF_FILE, {});
  const now = Date.now();
  const dayStart = now - 24 * 3600000;

  // Delivery
  const dayDelivery = ords.delivery.filter(o => o.status === 'done' && o.createdAt >= dayStart);
  const dayTaxi     = ords.taxi.filter(o => o.status === 'done' && o.createdAt >= dayStart);

  // Per courier payouts
  const courierPayouts = {}; // uid -> { nick, bank, delivery, taxi }
  for (const o of dayDelivery) {
    if (!o.courierId) continue;
    const p = staff[o.courierId];
    if (!p) continue;
    const hasBrandCar = (p.vehicles || []).some(v => v.brandColor) || (p.orgVehicles || []).length > 0;
    const pct = hasBrandCar ? 0.10 : 0.15;
    const wage = Math.round(o.total * (1 - pct) - (o.costTotal || 0));
    if (!courierPayouts[o.courierId]) courierPayouts[o.courierId] = { nick: p.nick, bank: p.bank, delivery: 0, taxi: 0 };
    courierPayouts[o.courierId].delivery += wage;
  }
  for (const o of dayTaxi) {
    if (!o.courierId) continue;
    const p = staff[o.courierId];
    if (!p) continue;
    const hasBrandCar = (p.vehicles || []).some(v => v.brandColor) || (p.orgVehicles || []).length > 0;
    const pct = hasBrandCar ? 0.10 : 0.15;
    const wage = Math.round(o.finalPrice * (1 - pct));
    if (!courierPayouts[o.courierId]) courierPayouts[o.courierId] = { nick: p.nick, bank: p.bank, delivery: 0, taxi: 0 };
    courierPayouts[o.courierId].taxi += wage;
  }

  const payoutLines = Object.entries(courierPayouts).map(([uid, c]) => {
    const total = c.delivery + c.taxi;
    return `• ${c.nick} — ${total}р. (счёт: ${c.bank})${c.delivery ? `\n  Доставка: ${c.delivery}р.` : ''}${c.taxi ? `\n  Такси: ${c.taxi}р.` : ''}`;
  }).join('\n') || '(нет завершённых заказов)';

  const text = `Ежедневный отчёт (${formatDateMSK()}):\n\nЗаказы доставки: ${dayDelivery.length}\nЗаказы такси: ${dayTaxi.length}\n\nВыплаты курьерам:\n${payoutLines}`;
  const keyboard = kb([[{ label: 'Обработано', color: 'positive', payload: { action: 'report_processed', date: formatDateMSK() } }]]);

  await sendMessage(CHATS.rukovodstvo, text, { keyboard }, 1);
}

async function sendWeeklyReport() {
  const ords  = readJSON(ORDERS_FILE, { delivery: [], taxi: [] });
  const staff = readJSON(STAFF_FILE, {});
  const now   = Date.now();
  const weekStart = now - 7 * 24 * 3600000;

  const weekDelivery = ords.delivery.filter(o => o.status === 'done' && o.createdAt >= weekStart);
  const weekTaxi     = ords.taxi.filter(o => o.status === 'done' && o.createdAt >= weekStart);

  // Revenue and payouts
  let totalRevenue = 0;
  const courierWeek = {}; // uid -> { nick, bank, wage, deliveryCnt, taxiCnt }

  for (const o of [...weekDelivery, ...weekTaxi]) {
    const price = o.total || o.finalPrice || 0;
    const p = staff[o.courierId];
    if (!p) continue;
    const hasBrandCar = (p.vehicles || []).some(v => v.brandColor) || (p.orgVehicles || []).length > 0;
    const pct  = hasBrandCar ? 0.10 : 0.15;
    const cost = o.costTotal || 0;
    // Зарплата = Стоимость − Себестоимость − 15%(Стоимость)
    const wage = Math.round(price * (1 - pct) - cost);
    totalRevenue += Math.round(price * pct) - Math.round(cost * 0.05) - Math.round(wage * 0.05);

    if (!courierWeek[o.courierId]) courierWeek[o.courierId] = { nick: p.nick, bank: p.bank, wage: 0, deliveryCnt: 0, taxiCnt: 0 };
    courierWeek[o.courierId].wage += Math.max(0, wage);
    if (o.type === 'delivery') courierWeek[o.courierId].deliveryCnt++;
    else courierWeek[o.courierId].taxiCnt++;
  }

  // Online stats
  const weekRanking = buildWeekRanking(getWeekStart());

  const payoutLines = Object.entries(courierWeek).map(([uid, c]) => {
    return `• ${c.nick} — ${c.wage}р. (счёт: ${c.bank})\n  Доставка: ${c.deliveryCnt} зак. | Такси: ${c.taxiCnt} зак.`;
  }).join('\n') || '(нет)';

  const topOnline = weekRanking.slice(0, 3).map((r, i) => {
    const oj = readJSON(ONLINE_FILE, { stats: {} });
    const ws = getWeekStart();
    const ms = Object.entries((oj.stats[r.uid] || {}).weeklyMs || {}).filter(([d]) => d >= ws).reduce((s, [,v]) => s+v, 0);
    const staffEntry = Object.values(staff).find(s => String(s.uid) === String(r.uid));
    return `${i+1}. ${staffEntry?.nick || 'id'+r.uid} — ${msToHuman(ms)}`;
  }).join('\n');

  const text = `Еженедельный отчёт (${formatDateMSK()}):\n\nЗаказы доставки: ${weekDelivery.length}\nЗаказы такси: ${weekTaxi.length}\n\nДоход организации: ${Math.max(0, totalRevenue)}р.\n\nЗарплаты сотрудников:\n${payoutLines}\n\nТоп по онлайну за неделю:\n${topOnline || '(нет данных)'}`;
  const keyboard = kb([[{ label: 'Обработано', color: 'positive', payload: { action: 'report_processed', date: formatDateMSK() } }]]);

  await sendMessage(CHATS.rukovodstvo, text, { keyboard }, 1);
}

// Schedule daily (18:00 MSK) and weekly (Sunday 18:00 MSK)
function scheduleReports() {
  function msUntil18MSK() {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
    const next = new Date(now);
    next.setHours(18, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  }

  function tick() {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
    const isWeekly = now.getDay() === 0; // Sunday
    if (isWeekly) sendWeeklyReport().catch(e => console.error('[Bot] weeklyReport:', e.message));
    else sendDailyReport().catch(e => console.error('[Bot] dailyReport:', e.message));
    setTimeout(tick, msUntil18MSK());
  }

  setTimeout(tick, msUntil18MSK());
  console.log('[Bot] Отчёты запланированы (18:00 МСК)');
}

// ─────────────────────────── EXISTING CHAT COMMANDS ──────────────
// Preserved from original bot: !пост, !приветствие, !закреп, !кик, !увед, !диагностика, !бан, !мут, !разбан, !размут

async function reuploadPhotoToGroup(photoAttachment, groupId, groupKey) {
  try {
    const sizes = photoAttachment.sizes || [];
    if (!sizes.length) return null;
    sizes.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    const photoUrl = sizes[0].url;
    const photoResponse = await fetch(photoUrl);
    const photoBuffer = await photoResponse.arrayBuffer();
    const uploadServer = await callVK('photos.getWallUploadServer', { group_id: groupId }, groupKey);
    const FormData = require('form-data');
    const formData = new FormData();
    formData.append('photo', Buffer.from(photoBuffer), { filename: 'photo.jpg', contentType: 'image/jpeg' });
    const uploadResponse = await fetch(uploadServer.upload_url, { method: 'POST', body: formData, headers: formData.getHeaders() });
    const uploadResult = await uploadResponse.json();
    const saveResult = await callVK('photos.saveWallPhoto', { group_id: groupId, photo: uploadResult.photo, server: uploadResult.server, hash: uploadResult.hash }, groupKey);
    if (saveResult && saveResult[0]) {
      const saved = saveResult[0];
      return `photo${saved.owner_id}_${saved.id}`;
    }
    return null;
  } catch (e) { console.error('[Bot] reuploadPhoto:', e.message); return null; }
}

function createUserLink(user) { return `[vk.com/id${user.id}|${user.first_name} ${user.last_name}]`; }
function extractUserId(link) {
  const patterns = [/vk\.com\/id(\d+)/, /\[vk\.com\/id(\d+)\|/, /^id(\d+)$/, /^(\d+)$/];
  for (const p of patterns) { const m = link.match(p); if (m) return parseInt(m[1]); }
  return null;
}
function parseDuration(text) {
  text = text.toLowerCase().trim();
  if (text.match(/\d+\s*(мин|м|min)/)) return parseInt(text.match(/(\d+)/)[1]);
  if (text.match(/\d+\s*(час|ч|h|hour)/)) return parseInt(text.match(/(\d+)/)[1]) * 60;
  if (text.match(/\d+\s*(день|д|d|day)/)) return parseInt(text.match(/(\d+)/)[1]) * 1440;
  return null;
}

async function handleChatCommand(event, groupKey) {
  const text    = (event.text || '').trim();
  const uid     = event.from_id;
  const peerId  = event.peer_id;
  const reply   = event.reply_message;

  if (!text.startsWith('!')) return false;

  const parts = text.split(/\s+/);
  const cmd   = parts[0].toLowerCase();

  // Mute check
  if (uid > 0) {
    const muteInfo = isMuted(uid);
    if (muteInfo && cmd !== '!диагностика') {
      const remaining = Math.ceil((muteInfo.endDate - Date.now()) / 60000);
      await sendMessage(peerId, `Вы замучены ещё на ${remaining} мин. (${muteInfo.reason})`, {}, groupKey);
      return true;
    }
  }

  // !чат
  if (cmd === '!чат') {
    await sendMessage(peerId, `ID этого чата: ${peerId}`, {}, groupKey);
    return true;
  }

  // !стата — handled in journal context too, but allow in any chat
  if (cmd === '!стата') {
    await handleStatsCommand(event);
    return true;
  }

  // Permission-gated commands
  const role   = await getUserRole(uid);
  const isRs   = role === 'rs';
  const isSs   = role === 'ss' || isRs;

  // !пост
  if (cmd === '!пост') {
    if (!isSs) { await sendMessage(peerId, 'Команда доступна только РС и СС', {}, groupKey); return true; }
    if (!reply) { await sendMessage(peerId, 'Ответьте на сообщение для публикации', {}, groupKey); return true; }
    try {
      const msg = reply; const postText = msg.text || ''; const attachments = [];
      for (const att of msg.attachments || []) {
        if (att.type === 'photo' && att.photo) {
          const pid = await reuploadPhotoToGroup(att.photo, G2_ID, 2);
          if (pid) attachments.push(pid);
        } else if (att.type === 'video' && att.video) {
          let vid = `video${att.video.owner_id}_${att.video.id}`; if (att.video.access_key) vid += `_${att.video.access_key}`; attachments.push(vid);
        }
      }
      await callVK('wall.post', { owner_id: `-${G2_ID}`, message: postText, attachments: attachments.join(','), from_group: 1 }, 2);
      await sendMessage(peerId, 'Пост опубликован в группе 2', {}, groupKey);
    } catch (e) { await sendMessage(peerId, 'Ошибка публикации: ' + e.message, {}, groupKey); }
    return true;
  }

  // !приветствие [чат]
  if (cmd === '!приветствие') {
    if (!isRs) { await sendMessage(peerId, 'Только РС', {}, groupKey); return true; }
    if (!reply) { await sendMessage(peerId, 'Ответьте на сообщение с текстом приветствия', {}, groupKey); return true; }
    const targetChat = parts[1] ? parseInt(parts[1]) : peerId;
    storage.greetings.set(targetChat, reply.text || '');
    await sendMessage(peerId, `Приветствие для чата ${targetChat} установлено`, {}, groupKey);
    return true;
  }

  // !закреп
  if (cmd === '!закреп') {
    if (!isRs) { await sendMessage(peerId, 'Только РС', {}, groupKey); return true; }
    if (!reply) { await sendMessage(peerId, 'Ответьте на сообщение для закрепления', {}, groupKey); return true; }
    try {
      await callVK('messages.pin', { peer_id: peerId, conversation_message_id: reply.conversation_message_id });
      await sendMessage(peerId, 'Сообщение закреплено', {}, groupKey);
    } catch (e) { await sendMessage(peerId, 'Ошибка закрепа: ' + e.message, {}, groupKey); }
    return true;
  }

  // !кик
  if (cmd === '!кик') {
    if (!isSs) { await sendMessage(peerId, 'Только РС и СС', {}, groupKey); return true; }
    let targetId = null;
    if (reply) targetId = reply.from_id;
    else if (parts[1]) targetId = extractUserId(parts[1]);
    if (!targetId || targetId <= 0) { await sendMessage(peerId, 'Укажите пользователя', {}, groupKey); return true; }
    try {
      await callVK('messages.removeChatUser', { chat_id: peerId - 2000000000, member_id: targetId }, groupKey);
      const target = await getUser(targetId, groupKey);
      await sendMessage(peerId, `${target ? createUserLink(target) : targetId} исключён`, {}, groupKey);
    } catch (e) { await sendMessage(peerId, 'Ошибка кика: ' + e.message, {}, groupKey); }
    return true;
  }

  // !бан
  if (cmd === '!бан') {
    if (!isSs) { await sendMessage(peerId, 'Только РС и СС', {}, groupKey); return true; }
    let targetId = null;
    if (reply) targetId = reply.from_id;
    else if (parts[1]) targetId = extractUserId(parts[1]);
    if (!targetId) { await sendMessage(peerId, 'Укажите пользователя', {}, groupKey); return true; }
    const days = parseInt(parts[reply ? 1 : 2]) || 0;
    const reason = parts.slice(reply ? 2 : 3).join(' ') || 'Нарушение правил';
    addToBlacklist(targetId, days, reason, uid);
    const target = await getUser(targetId, groupKey);
    await sendMessage(peerId, `${target ? createUserLink(target) : targetId} забанен на ${days || 'ПЕРМАНЕНТНО'} дней. Причина: ${reason}`, {}, groupKey);
    return true;
  }

  // !разбан
  if (cmd === '!разбан') {
    if (!isSs) { await sendMessage(peerId, 'Только РС и СС', {}, groupKey); return true; }
    let targetId = parts[1] ? extractUserId(parts[1]) : null;
    if (!targetId) { await sendMessage(peerId, 'Укажите пользователя', {}, groupKey); return true; }
    const ok = removeFromBlacklist(targetId);
    await sendMessage(peerId, ok ? `Пользователь ${targetId} разбанен` : 'Пользователь не в бане', {}, groupKey);
    return true;
  }

  // !мут
  if (cmd === '!мут') {
    if (!isSs) { await sendMessage(peerId, 'Только РС и СС', {}, groupKey); return true; }
    let targetId = null;
    if (reply) targetId = reply.from_id;
    else if (parts[1]) targetId = extractUserId(parts[1]);
    if (!targetId) { await sendMessage(peerId, 'Укажите пользователя', {}, groupKey); return true; }
    const durationStr = reply ? parts[1] : parts[2];
    const minutes = parseDuration(durationStr || '60 минут') || 60;
    const reason = parts.slice(reply ? 2 : 3).join(' ') || 'Нарушение правил';
    addMute(targetId, minutes, reason, uid);
    const target = await getUser(targetId, groupKey);
    await sendMessage(peerId, `${target ? createUserLink(target) : targetId} замучен на ${minutes} мин. Причина: ${reason}`, {}, groupKey);
    return true;
  }

  // !размут
  if (cmd === '!размут') {
    if (!isSs) { await sendMessage(peerId, 'Только РС и СС', {}, groupKey); return true; }
    let targetId = parts[1] ? extractUserId(parts[1]) : null;
    if (!targetId) { await sendMessage(peerId, 'Укажите пользователя', {}, groupKey); return true; }
    const ok = removeMute(targetId);
    await sendMessage(peerId, ok ? `Мут снят с пользователя ${targetId}` : 'Пользователь не замучен', {}, groupKey);
    return true;
  }

  // !увед
  if (cmd === '!увед') {
    if (!isSs) { await sendMessage(peerId, 'Только РС и СС', {}, groupKey); return true; }
    const msg = reply ? reply.text : parts.slice(1).join(' ');
    if (!msg) { await sendMessage(peerId, 'Укажите текст', {}, groupKey); return true; }
    const chats = Object.values(CHATS).filter(v => v > 0);
    let sent = 0;
    for (const chatPeer of chats) {
      try { await sendMessage(chatPeer, `📢 Объявление:\n${msg}`, {}, groupKey); sent++; } catch(_) {}
    }
    await sendMessage(peerId, `Уведомление отправлено в ${sent} чатов`, {}, groupKey);
    return true;
  }

  // !диагностика
  if (cmd === '!диагностика') {
    const checks = [];
    checks.push(`Группа 1 токен: ${G1_TOKEN ? '✅' : '❌'} | ID: ${G1_ID || '—'}`);
    checks.push(`Группа 2 токен: ${G2_TOKEN ? '✅' : '❌'} | ID: ${G2_ID || '—'}`);
    checks.push(`Группа 3 токен: ${G3_TOKEN ? '✅' : '❌'} | ID: ${G3_ID || '—'}`);
    checks.push(`Диспетчерская: ${CHATS.dispetcherskaya || '—'}`);
    checks.push(`Такси диспетч.: ${CHATS.taxiDispetcherskaya || '—'}`);
    checks.push(`Руководство: ${CHATS.rukovodstvo || '—'}`);
    checks.push(`Онлайн в журнале: ${storage.online.size} чел.`);
    await sendMessage(peerId, `Диагностика:\n${checks.join('\n')}`, {}, groupKey);
    return true;
  }

  return false;
}

// ─────────────────────────── CALLBACK HANDLER ─────────────────
async function handleCallback(event, groupKey) {
  const uid     = event.user_id || event.from_id;
  const peerId  = event.peer_id;
  let payload;
  try { payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload; }
  catch(_) { payload = {}; }

  const action = payload.action;

  // Accept order
  if (action === 'accept_order') {
    const orderId = payload.orderId;
    const order = storage.activeOrders.get(orderId) || storage.activeTaxi.get(orderId);
    if (!order || order.status !== 'pending') { return; }

    // Check online status
    const onlineInfo = storage.online.get(uid);
    if (!onlineInfo || !onlineInfo.online) {
      await sendMessage(uid, 'Вы не в онлайне. Напишите !онлайн в журнале активности.', {}, 1);
      return;
    }

    await handleCourierAcceptOrder(event, orderId);
    return;
  }

  // Toggle purchase item
  if (action === 'toggle_buy') {
    const { orderId, itemName } = payload;
    const order = storage.activeOrders.get(orderId) || storage.activeTaxi.get(orderId);
    if (!order || !order.purchaseItems) return;
    const item = order.purchaseItems.find(it => it.name === itemName);
    if (item) item.bought = !item.bought;

    // Rebuild keyboard
    const buttons = order.purchaseItems.map(it => ([{
      label: `${it.bought ? '[✓]' : '[ ]'} ${it.name} x${it.qty}`,
      color: it.bought ? 'positive' : 'secondary',
      payload: { action: 'toggle_buy', orderId, itemName: it.name },
    }]));
    const allBought = order.purchaseItems.every(it => it.bought);
    if (!allBought) {
      buttons.push([{ label: 'Всё куплено / Готовлю', color: 'positive', payload: { action: 'cooking_done', orderId } }]);
    } else {
      buttons.push([{ label: 'Готово! Еду к клиенту', color: 'positive', payload: { action: 'start_deliver', orderId } }]);
    }

    await editMessage(uid, order.purchaseMsgId, `Закупки (заказ #${orderId.slice(-6)}):`, { keyboard: kb(buttons) }, 1);
    return;
  }

  // Cooking done
  if (action === 'cooking_done') {
    const { orderId } = payload;
    const order = storage.activeOrders.get(orderId) || storage.activeTaxi.get(orderId);
    if (!order) return;
    order.status = 'accepted';
    // Update dispatch message
    const ids = storage.orderMsgIds.get(orderId);
    if (ids) {
      await editMessage(ids.chatId, ids.dispatchMsgId, `Заказ #${orderId.slice(-6)} — готовится (курьер: ${order.courierNick})`, {
        keyboard: kb([[{ label: 'Статус: Готовится', color: 'secondary', payload: {} }]])
      }, 1);
    }
    // Notify client
    await sendMessage(order.clientId, 'Ваш заказ готовится! Курьер скоро выедет.', {}, 2);
    return;
  }

  // Start delivery (delivery only — for taxi the driver uses "Прибыл" directly)
  if (action === 'start_deliver') {
    const { orderId } = payload;
    const order = storage.activeOrders.get(orderId) || storage.activeTaxi.get(orderId);
    if (!order) return;
    order.status = 'delivering';
    const gKey = order.type === 'taxi' ? 3 : 2;
    // Remind courier
    await sendMessage(uid,
      `Напоминание:\nКлиент: ${order.nick}\nАдрес: ${order.address || ((order.from?.name || '') + ' → ' + (order.to?.name || '')) || '—'}\nСумма: ${order.total || order.finalPrice}р.`,
      {}, 1);
    // Notify client
    await sendMessage(order.clientId,
      `Заказ готов! ${order.type === 'taxi' ? 'Водитель' : 'Курьер'} ${order.courierNick} едет к вам.`,
      { keyboard: msgKb([[{ label: 'Статус заказа' }], [{ label: 'Ссылка на курьера' }]]) }, gKey);
    return;
  }

  // Courier arrived
  if (action === 'courier_arrived') {
    const { orderId } = payload;
    const order = storage.activeOrders.get(orderId) || storage.activeTaxi.get(orderId);
    if (!order) return;
    order.status = 'arrived';
    await sendMessage(order.clientId, 'Курьер на месте!', {}, order.type === 'taxi' ? 3 : 2);
    // Show finish button to courier
    await sendMessage(uid, `Заказ #${orderId.slice(-6)} — вы на месте.`,
      { keyboard: kb([[{ label: 'Завершить заказ', color: 'positive', payload: { action: 'finish_order', orderId } }]]) }, 1);
    return;
  }

  // Finish order
  if (action === 'finish_order') {
    const { orderId } = payload;
    const order = storage.activeOrders.get(orderId) || storage.activeTaxi.get(orderId);
    if (!order) return;
    order.status = 'done';
    order.finishedAt = Date.now();

    // Update stats
    const staff = readJSON(STAFF_FILE, {});
    if (order.courierId && staff[order.courierId]) {
      if (order.type === 'taxi') staff[order.courierId].stats.taxiOrders = (staff[order.courierId].stats.taxiOrders || 0) + 1;
      else staff[order.courierId].stats.deliveryOrders = (staff[order.courierId].stats.deliveryOrders || 0) + 1;
      writeJSON(STAFF_FILE, staff);
    }

    // Persist
    const ords = readJSON(ORDERS_FILE, { delivery: [], taxi: [] });
    const list = order.type === 'taxi' ? ords.taxi : ords.delivery;
    const idx = list.findIndex(o => o.id === orderId);
    if (idx !== -1) list[idx] = order;
    writeJSON(ORDERS_FILE, ords);

    storage.activeOrders.delete(orderId);
    storage.activeTaxi.delete(orderId);

    // Notify client
    const reviewLink = `vk.com/wall-${G1_ID}?w=wall-${G1_ID}_1`; // placeholder
    await sendMessage(order.clientId,
      `Заказ завершён! Спасибо!\nОставьте отзыв или жалобу: ${reviewLink}`,
      { keyboard: msgKb([[{ label: 'Главное меню', color: 'secondary' }]]) },
      order.type === 'taxi' ? 3 : 2);

    await sendMessage(uid, `Заказ #${orderId.slice(-6)} завершён. Молодец!`, {}, 1);
    return;
  }

  // Taxi: paid waiting
  if (action === 'taxi_paid_waiting') {
    const { orderId } = payload;
    const order = storage.activeTaxi.get(orderId);
    if (!order) return;
    order.paidWaiting = true;
    await sendMessage(order.clientId, 'Водитель начал платное ожидание.', {}, 3);
    await sendMessage(uid, 'Платное ожидание включено.', {}, 1);
    return;
  }

  // Report processed
  if (action === 'report_processed') {
    await sendMessage(peerId, `Отчёт обработан ✅`, {}, 1);
    return;
  }
}

// ─────────────────────────── NEW-MEMBER GREETING ──────────────
async function handleNewMember(event, groupKey) {
  const peerId = event.peer_id;
  const greeting = storage.greetings.get(peerId);
  if (!greeting) return;
  const newMembers = event.action?.member_ids || [event.action?.member_id].filter(Boolean);
  for (const mid of newMembers) {
    if (mid < 0) continue; // bot itself
    const user = await getUser(mid, groupKey);
    const name = user ? `${user.first_name} ${user.last_name}` : `id${mid}`;
    await sendMessage(peerId, greeting.replace('{name}', name).replace('{id}', mid), {}, groupKey);
  }
}

// ─────────────────────────── EVENT ROUTER ────────────────────
async function handleEvent(event, groupKey) {
  try {
    const type   = event.type;
    const obj    = event.object;

    if (type === 'message_new') {
      const msg    = obj.message || obj;
      const peerId = msg.peer_id;
      const uid    = msg.from_id;
      const text   = (msg.text || '').trim();

      // Ignore bot messages
      if (uid <= 0) return;

      // Blacklist check
      const banInfo = isBlacklisted(uid);
      if (banInfo && peerId > 2000000000) return; // silently ignore banned users in chats

      // Journal commands in zhurnal chat
      if (peerId === CHATS.zhurnal) {
        await handleJournalMessage(msg);
        // !стата is also valid in journal chat
        if ((msg.text || '').trim().toLowerCase() === '!стата') {
          await handleStatsCommand(msg);
        }
        return;
      }

      // Chat commands (includes !стата, !диагностика, moderation etc.)
      if (peerId > 2000000000) {
        await handleChatCommand(msg, groupKey);
        return;
      }

      // DMs — peer_id equals the user's vk id for private messages
      if (peerId > 0 && peerId === uid) {
        if (groupKey === 2) {
          await handleDeliveryDM(msg);
        } else if (groupKey === 3) {
          await handleTaxiDM(msg);
        } else if (groupKey === 1) {
          // Handle vehicle add steps first
          const sess = storage.staffSessions.get(uid) || { step: null };
          if (['staff_veh_select','staff_veh_brandcolor','staff_veh_photo','staff_org_veh_select','staff_veh_delete',
               'Добавить личное авто','Взять авто організации','Удалить авто'].includes(sess.step) ||
              text === 'Добавить личное авто' || text === 'Взять авто организации' || text === 'Удалить авто') {
            const handled = await handleStaffVehicleAdd(uid, peerId, text, msg);
            if (handled) return;
          }
          // Taxi point admin
          const role = await getUserRole(uid);
          if (role === 'rs' || role === 'ss') {
            const handled2 = await handleTaxiPointAdmin(uid, peerId, text, msg);
            if (handled2) return;
          }
          await handleGroup1DM(msg);
        }
      }
    }

    if (type === 'message_event') {
      await handleCallback(obj, groupKey);
    }

    if (type === 'message_new') {
      const msg = obj.message || obj;
      if (msg.action && (msg.action.type === 'chat_invite_user' || msg.action.type === 'chat_invite_user_by_link')) {
        await handleNewMember(msg, groupKey);
      }
    }

    // Group post in group 1 → repost to doska
    if (type === 'wall_post_new' && groupKey === 1) {
      const post = obj;
      if (post.marked_as_ads || post.postponed) return;
      const text = post.text || '';
      const attachments = [];
      for (const att of post.attachments || []) {
        if (att.type === 'photo') attachments.push(`photo${att.photo.owner_id}_${att.photo.id}`);
      }
      try {
        await sendMessage(CHATS.doska, `📢 Новый пост в сообществе:\n${text}`, { attachment: attachments.join(',') }, 1);
      } catch(_) {}
    }

  } catch (e) {
    console.error('[Bot] handleEvent error:', e.message, e.stack?.split('\n')[1]);
  }
}

// ─────────────────────────── LONG POLL ───────────────────────
async function getLongPollServer(groupId, token) {
  const url  = `https://api.vk.com/method/groups.getLongPollServer`;
  const body = new URLSearchParams({ group_id: groupId, access_token: token, v: VK_API_VERSION });
  const res  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const data = await res.json();
  if (data.error) throw new Error(`getLongPollServer: ${data.error.error_msg}`);
  return data.response;
}

async function pollGroup(groupId, token, groupKey, label) {
  let { key, server, ts } = await getLongPollServer(groupId, token);
  console.log(`[Bot][${label}] Long-poll started, ts=${ts}`);

  while (true) {
    try {
      const url = `${server}?act=a_check&key=${key}&ts=${ts}&wait=25`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const data = await res.json();

      if (data.failed) {
        if (data.failed === 1) { ts = data.ts; continue; }
        const fresh = await getLongPollServer(groupId, token);
        key = fresh.key; server = fresh.server; ts = fresh.ts;
        continue;
      }

      ts = data.ts;
      for (const update of data.updates || []) {
        await handleEvent(update, groupKey);
      }
    } catch (e) {
      if (e.name === 'TimeoutError') continue;
      console.error(`[Bot][${label}] Poll error:`, e.message);
      await new Promise(r => setTimeout(r, 3000));
      try {
        const fresh = await getLongPollServer(groupId, token);
        key = fresh.key; server = fresh.server; ts = fresh.ts;
      } catch (_) {}
    }
  }
}

// ─────────────────────────── ENTRYPOINT ──────────────────────
async function main() {
  console.log('[Bot] Запуск...');

  scheduleReports();

  const pollers = [
    pollGroup(G1_ID, G1_TOKEN, 1, 'Группа1'),
  ];

  if (G2_TOKEN && G2_ID) {
    pollers.push(pollGroup(G2_ID, G2_TOKEN, 2, 'Группа2'));
  } else {
    console.warn('[Bot] Группа 2 не настроена (VK_GROUP2_TOKEN / VK_GROUP2_ID)');
  }

  if (G3_TOKEN && G3_ID && G3_TOKEN !== 'REPLACE_WITH_GROUP3_TOKEN') {
    pollers.push(pollGroup(G3_ID, G3_TOKEN, 3, 'Группа3'));
  } else {
    console.warn('[Bot] Группа 3 не настроена (VK_GROUP3_TOKEN / VK_GROUP3_ID)');
  }

  await Promise.all(pollers);
}

main().catch(e => { console.error('[Bot] Fatal:', e.message); process.exit(1); });
