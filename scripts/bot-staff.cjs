/**
 * bot-staff.cjs
 * Система сотрудников:
 *  - Регистрация и профиль в ЛС ГР1 (!профиль)
 *  - Автопарк (личный и организации)
 *  - Журнал Активности (!онлайн / !афк / !вышел)
 *  - Команда !стата (статистика онлайна)
 *  - Управление товарами/сетами/категориями руководством в ЛС ГР1
 *  - Добавление промокодов (РС/СС в ЛС ГР1 для доставки, ГР3 для такси)
 */

const {
  staffGet, staffCreate, staffUpdate, staffGetAll,
  vehicleAdd, vehicleGetAll, vehicleRemove,
  orgVehicleAdd, orgVehicleGetAll, orgVehicleGet,
  categoryGetAll, categoryGet, categoryAdd, categoryRemove,
  productGetAll, productGet, productAdd, productUpdate, productRemove,
  setGetAll, setGet, setItems, setAdd, setRemove,
  promoAdd, promoRemove, promoGetAll, promoGet,
  onlineSet, onlineRemove, onlineGet, onlineGetAll, onlineSetMsgId,
  activityLogAdd,
} = require('./db.cjs');

// Состояния регистрации: vkId -> { step, data }
const regSessions = new Map();
// Состояния добавления товара/категории/сета руководством: vkId -> { step, data }
const mgmtSessions = new Map();
// Временные данные для добавления авто: vkId -> { step, data }
const vehicleSessions = new Map();

// ========== УТИЛИТЫ ==========

function btn(label, payload, color = 'default') {
  return { action: { type: 'callback', label, payload: JSON.stringify(payload) }, color };
}
function makeKeyboard(rows, inline = true) {
  return JSON.stringify({ inline, buttons: rows });
}
function safeJson(str, def) {
  try { return JSON.parse(str); } catch { return def; }
}

// ========== ЖУРНАЛ АКТИВНОСТИ ==========

const ROLE_LABELS = { rs: 'РС', ss: 'СС', kurier: 'Курьер', stazher: 'Стажёр' };

function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

/**
 * Обрабатывает команды !онлайн, !афк, !вышел в чате Журнала Активности
 * @param {object} vkMsg    — message объект из VK
 * @param {object} api      { sendGroup1, editGroup1, CHATS, getUserInfo }
 */
async function handleActivityLog(vkMsg, api) {
  const { sendGroup1, editGroup1, CHATS, getUserInfo } = api;
  const text = (vkMsg.text || '').trim();
  const userId = vkMsg.from_id;
  const peerId = vkMsg.peer_id;

  const onlineMatch = text.match(/^!онлайн(?:\s+(.+))?$/i);
  const afkMatch    = text.match(/^!афк(?:\s+(.+))?$/i);
  const offlineMatch = text.match(/^!вышел/i);
  const stataMatch  = text.match(/^!стата/i);

  if (!onlineMatch && !afkMatch && !offlineMatch && !stataMatch) return false;

  const staff = staffGet(userId);
  const nick = staff ? staff.nick : `id${userId}`;
  const role = staff ? staff.role : 'kurier';

  // Определяем флаги орг из членства в чатах
  let orgFlags = {};
  if (staff) {
    // Флаги хранятся в org_flags поле staff
    orgFlags = safeJson(staff.org_flags || '{}', {});
  }

  if (onlineMatch) {
    // Определяем статус
    let statusText = onlineMatch[1] ? onlineMatch[1].trim() : '';
    if (!statusText) {
      if (role === 'stazher') statusText = 'экзамен';
      else statusText = 'доставка';
    }

    const prev = onlineGet(userId);
    onlineSet(userId, nick, role, 'online', statusText, orgFlags);
    activityLogAdd(userId, nick, role, 'online', statusText, orgFlags);

    // Строим сообщение ЖА
    const msgText = buildOnlineMessage(nick, role, statusText, 'online');
    let msgId;
    try {
      msgId = await sendGroup1(peerId, msgText);
    } catch (e) { }
    if (msgId) onlineSetMsgId(userId, msgId);
    return true;
  }

  if (afkMatch) {
    const statusText = afkMatch[1] ? afkMatch[1].trim() : 'Не у ПК';
    onlineSet(userId, nick, role, 'afk', statusText, orgFlags);
    activityLogAdd(userId, nick, role, 'afk', statusText, orgFlags);
    const msgText = buildOnlineMessage(nick, role, statusText, 'afk');
    try { await sendGroup1(peerId, msgText); } catch (e) { }
    return true;
  }

  if (offlineMatch) {
    onlineRemove(userId);
    activityLogAdd(userId, nick, role, 'offline', '', orgFlags);
    const all = onlineGetAll();
    const msgText = buildOfflineMessage(nick, role, all);
    try { await sendGroup1(peerId, msgText); } catch (e) { }
    return true;
  }

  if (stataMatch) {
    // Статистика онлайна сотрудника
    const statsText = buildStataText(userId, nick);
    try { await sendGroup1(peerId, statsText); } catch (e) { }
    return true;
  }

  return false;
}

function buildOnlineMessage(nick, role, statusText, status) {
  const action = status === 'online' ? 'в сети' : 'АФК';
  const all = onlineGetAll();

  let msg = `${nick} ${action}. (${statusText})\nНа сервере:\n`;
  const lines = all.map(u => `${u.nick} (${roleLabel(u.role)}) ${u.status_text}`);
  msg += lines.join('\n');
  return msg;
}

function buildOfflineMessage(nick, role, all) {
  let msg = `${nick} вышел.\nНа сервере:\n`;
  if (all.length === 0) {
    msg += '(никого)';
  } else {
    const lines = all.map(u => `${u.nick} (${roleLabel(u.role)}) ${u.status_text}`);
    msg += lines.join('\n');
  }
  return msg;
}

function buildStataText(userId, nick) {
  // Подсчитываем онлайн за сегодня из activity_log
  const db = require('./db.cjs').db;
  const todayStr = new Date().toISOString().split('T')[0];
  const logs = db.prepare(
    "SELECT * FROM activity_log WHERE vk_id = ? AND date(changed_at/1000,'unixepoch') = ? ORDER BY changed_at ASC"
  ).all(userId, todayStr);

  let onlineMs = 0;
  let lastOnline = null;
  for (const log of logs) {
    if (log.status === 'online') {
      lastOnline = log.changed_at;
    } else if (log.status === 'offline' && lastOnline) {
      onlineMs += log.changed_at - lastOnline;
      lastOnline = null;
    }
  }
  // Если сейчас онлайн
  const current = onlineGet(userId);
  if (current && current.status === 'online' && lastOnline) {
    onlineMs += Date.now() - lastOnline;
  }

  const totalMins = Math.floor(onlineMs / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;

  const staff = staffGet(userId);
  const ordersDone = staff ? staff.orders_done : 0;
  const ordersWeek = staff ? staff.orders_week : 0;

  return (
    `Статистика ${nick}:\n` +
    `Онлайн сегодня: ${hours}ч. ${mins}мин.\n` +
    `Заказов выполнено (всего): ${ordersDone}\n` +
    `Заказов за неделю: ${ordersWeek}`
  );
}

// ========== ПРОФИЛЬ СОТРУДНИКА ==========

/**
 * Обрабатывает команду !профиль в ЛС ГР1
 */
async function handleStaffProfile(vkMsg, api) {
  const { sendGroup1 } = api;
  const userId = vkMsg.from_id;
  const peerId = vkMsg.peer_id;
  const text = (vkMsg.text || '').trim();

  // Проверяем активную сессию регистрации
  const reg = regSessions.get(userId);
  if (reg) {
    return await handleRegStep(userId, peerId, text, vkMsg, reg, api);
  }

  // Проверяем активную сессию добавления авто
  const vs = vehicleSessions.get(userId);
  if (vs) {
    return await handleVehicleStep(userId, peerId, text, vkMsg, vs, api);
  }

  if (!text.startsWith('!профиль') && !text.startsWith('!автопарк')) return false;

  const staff = staffGet(userId);

  if (text === '!профиль') {
    if (!staff) {
      // Начать регистрацию
      regSessions.set(userId, { step: 'nick', data: {} });
      await sendGroup1(peerId, 'Добро пожаловать! Создаём профиль.\n\nВведите ваш никнейм:');
      return true;
    }
    // Показать профиль
    return await showProfile(userId, peerId, staff, api);
  }

  if (text === '!автопарк' || text.startsWith('!автопарк')) {
    if (!staff) {
      await sendGroup1(peerId, 'Сначала создайте профиль командой !профиль');
      return true;
    }
    return await showVehicleMenu(userId, peerId, staff, api);
  }

  return false;
}

async function handleRegStep(userId, peerId, text, vkMsg, reg, api) {
  const { sendGroup1 } = api;

  if (reg.step === 'nick') {
    if (!text || text.length < 2 || text.startsWith('!')) {
      await sendGroup1(peerId, 'Введите корректный никнейм (минимум 2 символа):');
      return true;
    }
    reg.data.nick = text;
    reg.step = 'bank';
    regSessions.set(userId, reg);
    await sendGroup1(peerId, `Никнейм: ${text}\n\nВведите ваш банковский счёт (номер карты или телефон):`,
      { keyboard: makeKeyboard([[btn('Пропустить (добавить позже)', { st: 'skip_bank' })]]) });
    return true;
  }

  if (reg.step === 'bank') {
    if (!text || text.length < 4) {
      await sendGroup1(peerId, 'Введите корректный банковский счёт:');
      return true;
    }
    reg.data.bank = text;
    reg.step = 'done';
    staffCreate(userId, reg.data.nick, reg.data.bank);
    regSessions.delete(userId);
    await sendGroup1(peerId,
      `Профиль создан!\nНикнейм: ${reg.data.nick}\nБанковский счёт: ${reg.data.bank}\n\n` +
      `Для работы необходимо добавить хотя бы одно авто.\nИспользуйте команду !автопарк`,
      { keyboard: makeKeyboard([[btn('Добавить авто', { st: 'add_vehicle' })]]) });
    return true;
  }

  return false;
}

async function showProfile(userId, peerId, staff, api) {
  const { sendGroup1 } = api;
  const vehicles = vehicleGetAll(userId);
  const orgFlags = safeJson(staff.org_flags || '{}', {});
  const orgsText = Object.entries(orgFlags).filter(([, v]) => v).map(([k]) => k).join(', ') || 'не указана';

  let text = `Профиль сотрудника\n\n` +
    `Никнейм: ${staff.nick}\n` +
    `Банковский счёт: ${staff.bank_acc || '—'}\n` +
    `Роль: ${roleLabel(staff.role)}\n` +
    `Организации: ${orgsText}\n` +
    `Заказов выполнено: ${staff.orders_done}\n\n` +
    `Автопарк (${vehicles.length} авто):`;

  for (const v of vehicles) {
    text += `\n— ${v.name} (${v.is_org ? 'орг.' : 'личное'})${v.is_colored ? ', в цветах' : ''}`;
  }

  await sendGroup1(peerId, text, {
    keyboard: makeKeyboard([
      [btn('Изменить никнейм', { st: 'edit_nick' }), btn('Изменить счёт', { st: 'edit_bank' })],
      [btn('Автопарк', { st: 'show_vehicles' })],
    ])
  });
  return true;
}

async function showVehicleMenu(userId, peerId, staff, api) {
  const { sendGroup1 } = api;
  const vehicles = vehicleGetAll(userId);
  const orgVehicles = orgVehicleGetAll();

  let text = `Автопарк\n\nВаши авто:\n`;
  if (vehicles.length === 0) {
    text += '(нет авто, добавьте хотя бы одно)\n';
  } else {
    for (const v of vehicles) {
      text += `— ${v.name} (${v.is_org ? 'авто организации' : 'личное'})${v.is_colored ? ', в цветах компании' : ''}\n`;
    }
  }

  const rows = [];
  if (orgVehicles.length > 0) {
    rows.push([btn('Взять авто организации', { st: 'pick_org_vehicle' })]);
  }
  rows.push([btn('Добавить личное авто', { st: 'add_personal_vehicle' })]);
  if (vehicles.length > 0) {
    rows.push([btn('Удалить авто', { st: 'remove_vehicle' })]);
  }
  rows.push([btn('Назад к профилю', { st: 'profile' }, 'negative')]);

  await sendGroup1(peerId, text, { keyboard: makeKeyboard(rows) });
  return true;
}

async function handleVehicleStep(userId, peerId, text, vkMsg, vs, api) {
  const { sendGroup1 } = api;

  if (vs.step === 'personal_name') {
    if (!text || text.length < 2) {
      await sendGroup1(peerId, 'Введите название авто:');
      return true;
    }
    vs.data.name = text;
    vs.step = 'personal_colored';
    vehicleSessions.set(userId, vs);
    await sendGroup1(peerId, `Авто: ${text}\n\nЭто авто в цветах организации?`,
      { keyboard: makeKeyboard([
        [btn('Да (комиссия 10%)', { st: 'colored_yes' }, 'positive'), btn('Нет (комиссия 15%)', { st: 'colored_no' })],
      ]) });
    return true;
  }

  if (vs.step === 'personal_photo') {
    // Ожидаем фото
    const hasPhoto = vkMsg.attachments && vkMsg.attachments.some(a => a.type === 'photo');
    if (!hasPhoto) {
      await sendGroup1(peerId, 'Пришлите фотографию личного авто:');
      return true;
    }
    const photo = vkMsg.attachments.find(a => a.type === 'photo');
    const photoId = `photo${photo.photo.owner_id}_${photo.photo.id}`;
    vehicleAdd(userId, vs.data.name, photoId, false, vs.data.isColored, null);
    vehicleSessions.delete(userId);
    await sendGroup1(peerId, `Личное авто "${vs.data.name}" добавлено в ваш автопарк!`);
    return true;
  }

  return false;
}

// ========== CALLBACK ОБРАБОТКА ДЛЯ ПРОФИЛЯ/АВТОПАРКА ==========

async function handleStaffCallback(event, api) {
  const { sendGroup1 } = api;
  const payload = typeof event.object.payload === 'string'
    ? JSON.parse(event.object.payload) : event.object.payload;
  if (!payload || !payload.st) return false;

  const userId = event.object.user_id;
  const peerId = event.object.peer_id;
  const st = payload.st;
  const staff = staffGet(userId);

  const answerCb = async () => {
    try {
      await api.callGroup1('messages.sendMessageEventAnswer', {
        event_id: event.object.event_id,
        user_id: userId,
        peer_id: peerId,
      });
    } catch (e) { }
  };

  await answerCb();

  if (st === 'skip_bank') {
    const reg = regSessions.get(userId);
    if (reg) {
      staffCreate(userId, reg.data.nick, null);
      regSessions.delete(userId);
      await sendGroup1(peerId,
        `Профиль создан!\nНикнейм: ${reg.data.nick}\n\nДля работы необходимо добавить авто. Используйте !автопарк`);
    }
    return true;
  }

  if (st === 'profile' || st === 'show_profile') {
    if (staff) await showProfile(userId, peerId, staff, api);
    return true;
  }

  if (st === 'show_vehicles') {
    if (staff) await showVehicleMenu(userId, peerId, staff, api);
    return true;
  }

  if (st === 'edit_nick') {
    regSessions.set(userId, { step: 'edit_nick_input', data: {} });
    await sendGroup1(peerId, 'Введите новый никнейм:');
    return true;
  }

  if (st === 'edit_bank') {
    regSessions.set(userId, { step: 'edit_bank_input', data: {} });
    await sendGroup1(peerId, 'Введите новый банковский счёт:');
    return true;
  }

  if (st === 'add_vehicle') {
    await showVehicleMenu(userId, peerId, staff, api);
    return true;
  }

  if (st === 'add_personal_vehicle') {
    vehicleSessions.set(userId, { step: 'personal_name', data: {} });
    await sendGroup1(peerId, 'Введите название вашего личного авто:');
    return true;
  }

  if (st === 'colored_yes' || st === 'colored_no') {
    const vs = vehicleSessions.get(userId);
    if (!vs) return true;
    vs.data.isColored = st === 'colored_yes';
    vs.step = 'personal_photo';
    vehicleSessions.set(userId, vs);
    await sendGroup1(peerId, 'Теперь пришлите фотографию авто:');
    return true;
  }

  if (st === 'pick_org_vehicle') {
    const orgVehicles = orgVehicleGetAll();
    if (orgVehicles.length === 0) {
      await sendGroup1(peerId, 'Авто организации пока не добавлены.');
      return true;
    }
    const rows = orgVehicles.map(v => [btn(v.name, { st: 'pick_org_vehicle_id', id: v.id })]);
    rows.push([btn('Назад', { st: 'show_vehicles' }, 'negative')]);
    await sendGroup1(peerId, 'Выберите авто организации:', { keyboard: makeKeyboard(rows) });
    return true;
  }

  if (st === 'pick_org_vehicle_id') {
    const orgV = orgVehicleGet(payload.id);
    if (!orgV) return true;
    vehicleAdd(userId, orgV.name, orgV.photo_url, true, true, orgV.id);
    await sendGroup1(peerId, `Авто "${orgV.name}" добавлено в ваш автопарк (авто организации).`);
    return true;
  }

  if (st === 'remove_vehicle') {
    const vehicles = vehicleGetAll(userId);
    if (vehicles.length === 0) {
      await sendGroup1(peerId, 'У вас нет авто.');
      return true;
    }
    const rows = vehicles.map(v => [btn(`Удалить: ${v.name}`, { st: 'do_remove_vehicle', id: v.id })]);
    rows.push([btn('Назад', { st: 'show_vehicles' }, 'negative')]);
    await sendGroup1(peerId, 'Выберите авто для удаления:', { keyboard: makeKeyboard(rows) });
    return true;
  }

  if (st === 'do_remove_vehicle') {
    vehicleRemove(payload.id);
    await sendGroup1(peerId, 'Авто удалено.');
    if (staff) await showVehicleMenu(userId, peerId, staff, api);
    return true;
  }

  return false;
}

// ========== УПРАВЛЕНИЕ ТОВАРАМИ/ПРОМОКОДАМИ (РС/СС в ЛС ГР1) ==========

/**
 * Обрабатывает команды управления в ЛС ГР1 для руководства
 */
async function handleManagement(vkMsg, api) {
  const { sendGroup1 } = api;
  const userId = vkMsg.from_id;
  const peerId = vkMsg.peer_id;
  const text = (vkMsg.text || '').trim();

  // Проверяем активную mgmt-сессию
  const ms = mgmtSessions.get(userId);
  if (ms) {
    return await handleMgmtStep(userId, peerId, text, vkMsg, ms, api);
  }

  // Команды управления
  if (text === '!управление' || text === '!меню') {
    return await showManagementMenu(userId, peerId, api);
  }

  if (text === '!добавить товар') {
    mgmtSessions.set(userId, { step: 'product_category', data: {} });
    return await showCategorySelectForProduct(userId, peerId, api);
  }

  if (text === '!добавить категорию') {
    mgmtSessions.set(userId, { step: 'cat_name', data: {} });
    await sendGroup1(peerId, 'Введите название новой категории:');
    return true;
  }

  if (text === '!добавить сет') {
    mgmtSessions.set(userId, { step: 'set_name', data: { items: [] } });
    await sendGroup1(peerId, 'Введите название сета:');
    return true;
  }

  if (text === '!добавить авто орг') {
    mgmtSessions.set(userId, { step: 'org_vehicle_name', data: {}, addedBy: userId });
    await sendGroup1(peerId, 'Введите название авто организации:');
    return true;
  }

  if (text === '!промокоды' || text === '!промокоды доставка') {
    const promos = promoGetAll('delivery');
    if (promos.length === 0) {
      await sendGroup1(peerId, 'Промокодов для доставки нет.');
      return true;
    }
    const lines = promos.map(p =>
      `${p.code} | ${p.type} | val:${p.value} | uses:${p.uses_left === -1 ? '∞' : p.uses_left}`
    );
    await sendGroup1(peerId, 'Промокоды (доставка):\n' + lines.join('\n'));
    return true;
  }

  if (text === '!промокоды такси') {
    const promos = promoGetAll('taxi');
    if (promos.length === 0) {
      await sendGroup1(peerId, 'Промокодов для такси нет.');
      return true;
    }
    const lines = promos.map(p =>
      `${p.code} | ${p.type} | val:${p.value} | uses:${p.uses_left === -1 ? '∞' : p.uses_left}`
    );
    await sendGroup1(peerId, 'Промокоды (такси):\n' + lines.join('\n'));
    return true;
  }

  // Быстрое добавление промокода: !промо [код] [org] [тип] [значение] [uses]
  // Пример: !промо SUMMER delivery discount_pct 10 100
  if (text.startsWith('!промо ')) {
    const parts = text.split(' ');
    if (parts.length < 5) {
      await sendGroup1(peerId, 'Использование:\n!промо [КОД] [delivery|taxi] [тип] [значение] [uses=-1]\n\nТипы доставки: discount_pct, discount_abs, free_product, free_category, discount_product_pct, discount_product_abs\nТипы такси: discount_pct, discount_abs, free_ride');
      return true;
    }
    const [, code, org, type, valueStr, usesStr] = parts;
    const value = parseInt(valueStr) || 0;
    const uses = usesStr ? parseInt(usesStr) : -1;
    promoAdd({ code: code.toUpperCase(), org, type, value, uses_left: uses, created_by: userId });
    await sendGroup1(peerId, `Промокод "${code.toUpperCase()}" создан (${org}, ${type}, ${value}, uses:${uses === -1 ? '∞' : uses}).`);
    return true;
  }

  // Удаление промокода: !удпромо [код]
  if (text.startsWith('!удпромо ')) {
    const code = text.split(' ')[1]?.toUpperCase();
    if (!code) { await sendGroup1(peerId, 'Укажите код: !удпромо [КОД]'); return true; }
    promoRemove(code);
    await sendGroup1(peerId, `Промокод "${code}" удалён.`);
    return true;
  }

  // Просмотр товаров: !товары [категория_id]
  if (text.startsWith('!товары')) {
    const parts = text.split(' ');
    const catId = parts[1] ? parseInt(parts[1]) : null;
    const products = productGetAll(catId || undefined);
    if (products.length === 0) {
      await sendGroup1(peerId, 'Товаров нет.');
      return true;
    }
    const lines = products.map(p => `#${p.id} ${p.name} | ${p.price}р. | себест. ${p.cost}р. | кат. ${p.category_id}`);
    await sendGroup1(peerId, 'Товары:\n' + lines.join('\n'));
    return true;
  }

  // Категории: !категории
  if (text === '!категории') {
    const cats = categoryGetAll();
    const lines = cats.map(c => `#${c.id} ${c.name}`);
    await sendGroup1(peerId, 'Категории:\n' + lines.join('\n'));
    return true;
  }

  // Сеты: !сеты
  if (text === '!сеты') {
    const sets = setGetAll();
    const lines = sets.map(s => `#${s.id} ${s.name} | ${s.price}р.`);
    await sendGroup1(peerId, sets.length ? 'Сеты:\n' + lines.join('\n') : 'Сетов нет.');
    return true;
  }

  // Удалить товар: !удтовар [id]
  if (text.startsWith('!удтовар ')) {
    const id = parseInt(text.split(' ')[1]);
    if (!id) { await sendGroup1(peerId, 'Укажите ID: !удтовар [id]'); return true; }
    productRemove(id);
    await sendGroup1(peerId, `Товар #${id} удалён.`);
    return true;
  }

  // Удалить сет: !удсет [id]
  if (text.startsWith('!удсет ')) {
    const id = parseInt(text.split(' ')[1]);
    if (!id) { await sendGroup1(peerId, 'Укажите ID: !удсет [id]'); return true; }
    setRemove(id);
    await sendGroup1(peerId, `Сет #${id} удалён.`);
    return true;
  }

  // Просмотр профиля сотрудника (РС/СС): !профиль @ник или !профиль [id]
  if (text.startsWith('!профиль ')) {
    const targetId = extractId(text.split(' ')[1]);
    if (!targetId) { await sendGroup1(peerId, 'Укажите ID или ссылку.'); return true; }
    const s = staffGet(targetId);
    if (!s) { await sendGroup1(peerId, `Сотрудник #${targetId} не найден.`); return true; }
    const vehicles = vehicleGetAll(targetId);
    let t = `Профиль #${targetId}\n` +
      `Ник: ${s.nick}\nСчёт: ${s.bank_acc || '—'}\nРоль: ${roleLabel(s.role)}\n` +
      `Заказов: ${s.orders_done} (неделя: ${s.orders_week})\n\nАвтопарк:\n`;
    if (vehicles.length === 0) t += '(нет)';
    else t += vehicles.map(v => `— ${v.name} (${v.is_org ? 'орг.' : 'личное'})${v.is_colored ? ', в цветах' : ''}`).join('\n');
    await sendGroup1(peerId, t);
    return true;
  }

  return false;
}

async function showManagementMenu(userId, peerId, api) {
  const { sendGroup1 } = api;
  await sendGroup1(peerId,
    'Управление (РС/СС):\n\n' +
    '!добавить товар — добавить товар\n' +
    '!добавить категорию — добавить категорию\n' +
    '!добавить сет — добавить сет\n' +
    '!добавить авто орг — добавить авто организации\n' +
    '!товары — список товаров\n' +
    '!категории — список категорий\n' +
    '!сеты — список сетов\n' +
    '!удтовар [id] — удалить товар\n' +
    '!удсет [id] — удалить сет\n' +
    '!промо [код] [org] [тип] [знач] [uses] — создать промокод\n' +
    '!удпромо [код] — удалить промокод\n' +
    '!промокоды / !промокоды такси — список\n' +
    '!профиль [id/ссылка] — просмотр профиля сотрудника'
  );
  return true;
}

async function showCategorySelectForProduct(userId, peerId, api) {
  const { sendGroup1 } = api;
  const cats = categoryGetAll();
  if (cats.length === 0) {
    mgmtSessions.delete(userId);
    await sendGroup1(peerId, 'Нет категорий. Сначала добавьте категорию: !добавить категорию');
    return true;
  }
  const rows = cats.map(c => [btn(c.name, { mg: 'product_cat', id: c.id })]);
  rows.push([btn('Отмена', { mg: 'cancel' }, 'negative')]);
  await sendGroup1(peerId, 'Выберите категорию для товара:', { keyboard: makeKeyboard(rows) });
  return true;
}

async function handleMgmtStep(userId, peerId, text, vkMsg, ms, api) {
  const { sendGroup1 } = api;

  // ---- Категория ----
  if (ms.step === 'cat_name') {
    if (!text || text.length < 2) { await sendGroup1(peerId, 'Введите название категории:'); return true; }
    const id = categoryAdd(text.trim(), null);
    mgmtSessions.delete(userId);
    await sendGroup1(peerId, `Категория "${text}" добавлена (ID: ${id}).`);
    return true;
  }

  // ---- Авто организации ----
  if (ms.step === 'org_vehicle_name') {
    if (!text || text.length < 2) { await sendGroup1(peerId, 'Введите название авто:'); return true; }
    ms.data.name = text;
    ms.step = 'org_vehicle_photo';
    mgmtSessions.set(userId, ms);
    await sendGroup1(peerId, 'Теперь пришлите фотографию авто (или напишите "пропустить"):');
    return true;
  }
  if (ms.step === 'org_vehicle_photo') {
    let photoId = null;
    if (vkMsg.attachments && vkMsg.attachments.some(a => a.type === 'photo')) {
      const photo = vkMsg.attachments.find(a => a.type === 'photo');
      photoId = `photo${photo.photo.owner_id}_${photo.photo.id}`;
    }
    const id = orgVehicleAdd(ms.data.name, photoId, ms.addedBy);
    mgmtSessions.delete(userId);
    await sendGroup1(peerId, `Авто "${ms.data.name}" добавлено в парк организации (ID: ${id}).`);
    return true;
  }

  // ---- Товар ----
  if (ms.step === 'product_name') {
    if (!text || text.length < 2) { await sendGroup1(peerId, 'Введите название товара:'); return true; }
    ms.data.name = text;
    ms.step = 'product_price';
    mgmtSessions.set(userId, ms);
    await sendGroup1(peerId, `Товар: ${text}\n\nВведите стоимость для клиентов (руб):`);
    return true;
  }
  if (ms.step === 'product_price') {
    const price = parseInt(text);
    if (!price || price <= 0) { await sendGroup1(peerId, 'Введите корректную цену:'); return true; }
    ms.data.price = price;
    ms.step = 'product_cost';
    mgmtSessions.set(userId, ms);
    await sendGroup1(peerId, `Стоимость: ${price}р.\n\nВведите себестоимость (для расчёта зарплат):`,
      { keyboard: makeKeyboard([[btn('Пропустить (= 0)', { mg: 'skip_cost' })]]) });
    return true;
  }
  if (ms.step === 'product_cost') {
    const cost = parseInt(text) || 0;
    ms.data.cost = cost;
    ms.step = 'product_simple';
    mgmtSessions.set(userId, ms);
    await sendGroup1(peerId,
      `Себестоимость: ${cost}р.\n\nУкажите простые составляющие через запятую (для курьера).\nПример: Тесто х1, Молоко х2\nИли нажмите "Пропустить":`,
      { keyboard: makeKeyboard([[btn('Пропустить', { mg: 'skip_simple' })]]) });
    return true;
  }
  if (ms.step === 'product_simple') {
    const simpleItems = parseSimpleItems(text);
    ms.data.simpleItems = simpleItems;
    ms.step = 'product_photo';
    mgmtSessions.set(userId, ms);
    await sendGroup1(peerId, 'Пришлите фото товара для каталога или нажмите "Пропустить":',
      { keyboard: makeKeyboard([[btn('Пропустить', { mg: 'skip_photo' })]]) });
    return true;
  }
  if (ms.step === 'product_photo') {
    let photoId = null;
    if (vkMsg.attachments && vkMsg.attachments.some(a => a.type === 'photo')) {
      const photo = vkMsg.attachments.find(a => a.type === 'photo');
      photoId = `photo${photo.photo.owner_id}_${photo.photo.id}`;
    }
    ms.data.photoUrl = photoId;
    ms.step = 'product_instruction';
    mgmtSessions.set(userId, ms);
    await sendGroup1(peerId, 'Пришлите фото-инструкцию для курьера или нажмите "Пропустить":',
      { keyboard: makeKeyboard([[btn('Пропустить', { mg: 'skip_instruction' })]]) });
    return true;
  }
  if (ms.step === 'product_instruction') {
    let instrPhoto = null;
    if (vkMsg.attachments && vkMsg.attachments.some(a => a.type === 'photo')) {
      const photo = vkMsg.attachments.find(a => a.type === 'photo');
      instrPhoto = `photo${photo.photo.owner_id}_${photo.photo.id}`;
    }
    const id = productAdd({
      categoryId: ms.data.categoryId,
      name: ms.data.name,
      price: ms.data.price,
      cost: ms.data.cost || 0,
      photoUrl: ms.data.photoUrl,
      instructionPhoto: instrPhoto,
      simpleItems: ms.data.simpleItems || [],
    });
    mgmtSessions.delete(userId);
    await sendGroup1(peerId, `Товар "${ms.data.name}" добавлен (ID: ${id}) в категорию #${ms.data.categoryId}.`);
    return true;
  }

  // ---- Сет ----
  if (ms.step === 'set_name') {
    if (!text || text.length < 2) { await sendGroup1(peerId, 'Введите название сета:'); return true; }
    ms.data.name = text;
    ms.step = 'set_price';
    mgmtSessions.set(userId, ms);
    await sendGroup1(peerId, `Сет: ${text}\n\nВведите стоимость:`);
    return true;
  }
  if (ms.step === 'set_price') {
    const price = parseInt(text);
    if (!price || price <= 0) { await sendGroup1(peerId, 'Введите корректную цену:'); return true; }
    ms.data.price = price;
    ms.step = 'set_cost';
    mgmtSessions.set(userId, ms);
    await sendGroup1(peerId, 'Введите себестоимость:',
      { keyboard: makeKeyboard([[btn('Пропустить (= 0)', { mg: 'set_skip_cost' })]]) });
    return true;
  }
  if (ms.step === 'set_cost') {
    const cost = parseInt(text) || 0;
    ms.data.cost = cost;
    ms.step = 'set_items';
    mgmtSessions.set(userId, ms);
    await sendGroup1(peerId,
      `Добавьте товары в сет.\nВведите ID товара и кол-во: "123 x2" или название: "Томат x1"\n` +
      `Текущий состав: ${(ms.data.items || []).map(i => i.name || `#${i.product_id}`).join(', ') || '(пусто)'}\n\n` +
      `Введите следующий товар или нажмите "Готово":`,
      { keyboard: makeKeyboard([[btn('Готово', { mg: 'set_done' }, 'positive')]]) });
    return true;
  }
  if (ms.step === 'set_items') {
    const match = text.match(/^(\d+|.+?)\s+x(\d+)$/i);
    if (!match) {
      await sendGroup1(peerId, 'Формат: "123 x2" (ID товара) или "Томат x1" (название)');
      return true;
    }
    const nameOrId = match[1].trim();
    const qty = parseInt(match[2]);
    const prodId = parseInt(nameOrId);
    if (!isNaN(prodId)) {
      const prod = productGet(prodId);
      ms.data.items.push({ product_id: prodId, name: prod ? prod.name : `#${prodId}`, qty });
    } else {
      ms.data.items.push({ product_id: null, name: nameOrId, qty });
    }
    mgmtSessions.set(userId, ms);
    await sendGroup1(peerId,
      `Состав: ${ms.data.items.map(i => `${i.name} x${i.qty}`).join(', ')}\n\nДобавить ещё или нажмите "Готово":`,
      { keyboard: makeKeyboard([[btn('Готово', { mg: 'set_done' }, 'positive')]]) });
    return true;
  }

  return false;
}

// ========== CALLBACK ДЛЯ УПРАВЛЕНИЯ ==========

async function handleManagementCallback(event, api) {
  const { sendGroup1 } = api;
  const payload = typeof event.object.payload === 'string'
    ? JSON.parse(event.object.payload) : event.object.payload;
  if (!payload || !payload.mg) return false;

  const userId = event.object.user_id;
  const peerId = event.object.peer_id;
  const mg = payload.mg;
  const ms = mgmtSessions.get(userId);

  const answerCb = async () => {
    try {
      await api.callGroup1('messages.sendMessageEventAnswer', {
        event_id: event.object.event_id,
        user_id: userId,
        peer_id: peerId,
      });
    } catch (e) { }
  };
  await answerCb();

  if (mg === 'cancel') {
    mgmtSessions.delete(userId);
    await sendGroup1(peerId, 'Отменено.');
    return true;
  }

  if (mg === 'product_cat') {
    const catId = payload.id;
    mgmtSessions.set(userId, { step: 'product_name', data: { categoryId: catId } });
    const cat = categoryGet(catId);
    await sendGroup1(peerId, `Категория: ${cat ? cat.name : catId}\n\nВведите название товара:`);
    return true;
  }

  if (mg === 'skip_cost' && ms) {
    ms.data.cost = 0;
    ms.step = 'product_simple';
    mgmtSessions.set(userId, ms);
    await sendGroup1(peerId, 'Укажите простые составляющие (или нажмите "Пропустить"):',
      { keyboard: makeKeyboard([[btn('Пропустить', { mg: 'skip_simple' })]]) });
    return true;
  }

  if (mg === 'skip_simple' && ms) {
    ms.data.simpleItems = [];
    ms.step = 'product_photo';
    mgmtSessions.set(userId, ms);
    await sendGroup1(peerId, 'Пришлите фото товара или нажмите "Пропустить":',
      { keyboard: makeKeyboard([[btn('Пропустить', { mg: 'skip_photo' })]]) });
    return true;
  }

  if (mg === 'skip_photo' && ms) {
    ms.data.photoUrl = null;
    ms.step = 'product_instruction';
    mgmtSessions.set(userId, ms);
    await sendGroup1(peerId, 'Пришлите фото-инструкцию для курьера или нажмите "Пропустить":',
      { keyboard: makeKeyboard([[btn('Пропустить', { mg: 'skip_instruction' })]]) });
    return true;
  }

  if (mg === 'skip_instruction' && ms) {
    const id = productAdd({
      categoryId: ms.data.categoryId,
      name: ms.data.name,
      price: ms.data.price,
      cost: ms.data.cost || 0,
      photoUrl: ms.data.photoUrl,
      instructionPhoto: null,
      simpleItems: ms.data.simpleItems || [],
    });
    mgmtSessions.delete(userId);
    await sendGroup1(peerId, `Товар "${ms.data.name}" добавлен (ID: ${id}).`);
    return true;
  }

  if (mg === 'set_skip_cost' && ms) {
    ms.data.cost = 0;
    ms.step = 'set_items';
    mgmtSessions.set(userId, ms);
    await sendGroup1(peerId, 'Добавьте товары в сет.\nФормат: "ID x кол-во" или "Название x кол-во"\nИли нажмите "Готово":',
      { keyboard: makeKeyboard([[btn('Готово', { mg: 'set_done' }, 'positive')]]) });
    return true;
  }

  if (mg === 'set_done' && ms) {
    if ((ms.data.items || []).length === 0) {
      await sendGroup1(peerId, 'Добавьте хотя бы один товар в сет.');
      return true;
    }
    const id = setAdd({
      name: ms.data.name,
      price: ms.data.price,
      cost: ms.data.cost || 0,
      photoUrl: null,
      items: ms.data.items,
    });
    mgmtSessions.delete(userId);
    await sendGroup1(peerId, `Сет "${ms.data.name}" создан (ID: ${id}) с ${ms.data.items.length} позициями.`);
    return true;
  }

  return false;
}

// ========== УТИЛИТЫ ==========

function parseSimpleItems(text) {
  if (!text || text.toLowerCase() === 'пропустить') return [];
  return text.split(',').map(part => {
    const m = part.trim().match(/^(.+?)\s+[xх](\d+)$/i);
    if (m) return { name: m[1].trim(), qty: parseInt(m[2]) };
    return { name: part.trim(), qty: 1 };
  }).filter(i => i.name);
}

function extractId(str) {
  if (!str) return null;
  const m = str.match(/(\d+)/);
  return m ? parseInt(m[1]) : null;
}

module.exports = {
  handleActivityLog,
  handleStaffProfile,
  handleStaffCallback,
  handleManagement,
  handleManagementCallback,
  buildStataText,
  regSessions,
  mgmtSessions,
  vehicleSessions,
};
