/**
 * bot-dispatcher.cjs
 * Система диспетчерской: маршрутизация заказов, помощник курьера/водителя, статусы, уведомления
 *
 * Поток (доставка):
 *  1. Клиент оформил заказ → notifyDispatch({orderId, org:'delivery'})
 *  2. Бот ГР1 отправляет в чат Диспетчерской сообщение с кнопкой "Принять заказ"
 *  3. Курьер нажимает кнопку → переходит в ЛС ГР1, вводит ник + ETA
 *  4. Бот проверяет онлайн-курьеров с org=delivery
 *  5. Если нет курьеров → сообщает клиенту
 *  6. Если не взяли за 3 минуты → уведомляет чат СС + всех курьеров в сети
 *  7. При принятии: курьеру → помощник с покупками, клиенту → уведомление
 *  8. Курьер отмечает позиции как купленные (редактирование кнопок)
 *  9. Курьер нажимает "Собрал заказ" → статус delivering, уведомление клиенту
 * 10. Курьер "Прибыл" → статус arrived
 * 11. Курьер "Завершить" → статус done, клиент получает предложение оставить отзыв
 *
 * Поток (такси):
 *  Аналогично, но с дополнительными статусами:
 *  waiting (ждёт клиента), платное ожидание
 */

const {
  orderGet, orderGetItems, orderUpdate, orderItemSetBought, orderGetByCourier,
  taxiGet, taxiUpdate, taxiGetByDriver,
  staffGet,
  onlineGetAll,
  dailyStatsIncrement,
  staffUpdate,
} = require('./db.cjs');

const { buildStatusText } = require('./bot-delivery-client.cjs');
const { buildTaxiStatusText } = require('./bot-taxi-client.cjs');

// Таймеры ожидания принятия заказа (orderId/taxiId -> timeoutHandle)
const acceptTimers = new Map();

// Статус link-запросов: 'delivery_link_${orderId}_${userId}' -> pending
const linkRequests = new Map();

// ========== УТИЛИТЫ ==========

function btn(label, payload, color = 'default') {
  return { action: { type: 'callback', label, payload: JSON.stringify(payload) }, color };
}
function makeKeyboard(rows, inline = true) {
  return JSON.stringify({ inline, buttons: rows });
}

// ========== ТЕКСТ ЗАКАЗА ДЛЯ ДИСПЕТЧЕРСКОЙ ==========

function buildDeliveryDispatchText(order, items) {
  const lines = items.map(i => `${i.name} | ${i.price}р. (х${i.qty})`);
  return (
    `Новый заказ #${order.id}\n` +
    `Никнейм: ${order.client_nick}\n` +
    `Место: ${order.location}\n` +
    `Оплата: ${order.payment_type === 'cash' ? 'Наличными' : 'Банк (оплачено)'}\n` +
    `Заказ:\n${lines.join('\n')}\n` +
    `Итого: ${order.total_price}р.`
  );
}

function buildTaxiDispatchText(order) {
  const passengers = JSON.parse(order.passengers || '[]');
  let text = `Новый заказ такси #${order.id}\n` +
    `Никнейм: ${order.client_nick}\n`;
  if (passengers.length > 0) text += `Попутчики: ${passengers.join(', ')}\n`;
  text += `Откуда: ${order.from_name}\nКуда: ${order.to_name}\n` +
    `Расстояние: ${order.distance_km} км\n` +
    `Оплата: ${order.payment_type === 'cash' ? 'Наличными' : 'Предоплата'}\n` +
    `Стоимость: ${order.total_price}р.`;
  return text;
}

// ========== ПОМОЩНИК КУРЬЕРА ==========

function buildHelperText(order, items) {
  // Разбиваем по: обычные товары и сеты
  // Для каждого товара показываем simple_items если есть
  const { productGet, setGet, setItems: getSetItems } = require('./db.cjs');

  const lines = [];
  const generalItems = [];

  for (const item of items) {
    if (item.set_id) {
      const setData = getSetItems(item.set_id);
      const setLabel = `Сет "${item.name}":`;
      const setLines = setData.map(si => {
        const prod = si.product_id ? productGet(si.product_id) : null;
        const name = prod ? prod.name : si.name;
        const simple = prod && prod.simple_items ? JSON.parse(prod.simple_items) : [];
        if (simple.length > 0) {
          return `  ${name} (Готовка: ${simple.map(s => `${s.name} х${s.qty}`).join(', ')})`;
        }
        return `  ${name} х${si.qty}`;
      });
      lines.push(setLabel);
      lines.push(...setLines);
    } else {
      const prod = item.product_id ? productGet(item.product_id) : null;
      const simple = prod && prod.simple_items ? JSON.parse(prod.simple_items) : [];
      if (simple.length > 0) {
        lines.push(`${item.name} (Готовка: ${simple.map(s => `${s.name} х${s.qty}`).join(', ')})`);
      } else {
        generalItems.push(`${item.name} х${item.qty}`);
      }
    }
  }

  let text = `Помощник курьера | Заказ #${order.id}\n`;
  text += `Клиент: ${order.client_nick}\nМесто: ${order.location}\nСумма: ${order.total_price}р.\n\n`;
  text += `Купить:\n`;
  if (generalItems.length > 0) text += `Общее: ${generalItems.join('; ')}\n`;
  if (lines.length > 0) text += lines.join('\n');
  return text;
}

function buildHelperKeyboard(items, orderId, org) {
  const rows = [];
  // Кнопка на каждый товар: отмечаем купленным
  for (const item of items) {
    const color = item.bought ? 'positive' : 'default';
    const label = (item.bought ? '[v] ' : '') + `${item.name} х${item.qty}`;
    rows.push([btn(label.substring(0, 40), { disp: 'toggle_item', iid: item.id, oid: item.order_id, org }, color)]);
  }
  rows.push([btn('Собрал заказ, еду к клиенту', { disp: 'delivering', oid: orderId, org }, 'positive')]);
  return makeKeyboard(rows);
}

function buildTaxiHelperKeyboard(taxiId) {
  return makeKeyboard([
    [btn('Клиент сел, едем', { disp: 'taxi_driving', oid: taxiId }, 'positive')],
    [btn('Включить платное ожидание', { disp: 'taxi_paid_wait', oid: taxiId })],
    [btn('Прибыли', { disp: 'taxi_arrived', oid: taxiId }, 'positive')],
    [btn('Завершить поездку', { disp: 'taxi_done', oid: taxiId }, 'positive')],
  ]);
}

// ========== ГЛАВНАЯ ФУНКЦИЯ: ОТПРАВКА В ДИСПЕТЧЕРСКУЮ ==========

/**
 * Вызывается после создания заказа клиентом
 * @param {object} orderRef     { orderId, org }
 * @param {object} api          { sendGroup1, sendGroup2, sendGroup3, editGroup1, CHATS, onlineGetAll }
 */
async function notifyDispatch(orderRef, api) {
  const { orderId, org } = orderRef;
  const { sendGroup1, CHATS, staffUpdateFn } = api;

  if (org === 'delivery') {
    const order = orderGet(orderId);
    if (!order) return;
    const items = require('./db.cjs').orderGetItems(orderId);

    // Проверяем онлайн-курьеров с org=delivery
    const online = onlineGetAll();
    const couriers = online.filter(u => {
      const flags = safeJson(u.org_flags, {});
      return flags.delivery && u.status === 'online';
    });

    if (couriers.length === 0) {
      // Нет курьеров — сообщить клиенту
      try {
        await api.sendGroup2(order.client_vk_id,
          'К сожалению, сейчас нет курьеров в сети. Попробуйте повторить заказ позже.');
      } catch (e) { }
      orderUpdate(orderId, { status: 'cancelled' });
      return;
    }

    const text = buildDeliveryDispatchText(order, items);
    const keyboard = makeKeyboard([[btn('Принять заказ', { disp: 'accept', oid: orderId, org: 'delivery' }, 'positive')]]);

    let dispMsgId = null;
    try {
      dispMsgId = await sendGroup1(CHATS.dispetcherskaya, text, { keyboard });
    } catch (e) {
      console.error('[Dispatcher] Ошибка отправки в диспетчерскую:', e.message);
      return;
    }
    if (dispMsgId) orderUpdate(orderId, { dispatch_msg_id: dispMsgId, status: 'pending' });

    // Таймер 3 минуты — если не приняли, уведомить СС и всех курьеров
    const timer = setTimeout(async () => {
      const fresh = orderGet(orderId);
      if (!fresh || fresh.status !== 'pending') return;
      const stillOnline = onlineGetAll().filter(u => {
        const flags = safeJson(u.org_flags, {});
        return flags.delivery && u.status === 'online';
      });
      const names = stillOnline.map(u => u.nick).join(', ');
      try {
        await sendGroup1(CHATS.ss,
          `Заказ #${orderId} не принят 3 минуты!\nКурьеры в сети: ${names || 'никого'}\nПожалуйста, обратитесь к ним.`);
        for (const courier of stillOnline) {
          await api.sendGroup1(courier.vk_id, `Непринятый заказ #${orderId}! Пожалуйста, проверьте диспетчерскую.`);
        }
      } catch (e) { }
    }, 3 * 60 * 1000);
    acceptTimers.set(`d_${orderId}`, timer);

  } else if (org === 'taxi') {
    const order = taxiGet(orderId);
    if (!order) return;

    const online = onlineGetAll();
    const drivers = online.filter(u => {
      const flags = safeJson(u.org_flags, {});
      return flags.taxi && u.status === 'online';
    });

    if (drivers.length === 0) {
      try {
        await api.sendGroup3(order.client_vk_id,
          'К сожалению, сейчас нет водителей в сети. Попробуйте повторить заказ позже.');
      } catch (e) { }
      taxiUpdate(orderId, { status: 'cancelled' });
      return;
    }

    const text = buildTaxiDispatchText(order);
    const keyboard = makeKeyboard([[btn('Принять заказ', { disp: 'accept', oid: orderId, org: 'taxi' }, 'positive')]]);

    const dispatchChat = CHATS.dispetcherskaya_taxi || CHATS.dispetcherskaya;
    let dispMsgId = null;
    try {
      dispMsgId = await sendGroup1(dispatchChat, text, { keyboard });
    } catch (e) {
      console.error('[Dispatcher] Ошибка отправки такси в диспетчерскую:', e.message);
      return;
    }
    if (dispMsgId) taxiUpdate(orderId, { dispatch_msg_id: dispMsgId, status: 'pending' });

    const timer = setTimeout(async () => {
      const fresh = taxiGet(orderId);
      if (!fresh || fresh.status !== 'pending') return;
      const stillOnline = onlineGetAll().filter(u => {
        const flags = safeJson(u.org_flags, {});
        return flags.taxi && u.status === 'online';
      });
      const names = stillOnline.map(u => u.nick).join(', ');
      try {
        await sendGroup1(CHATS.ss,
          `Заказ такси #${orderId} не принят 3 минуты!\nВодители в сети: ${names || 'никого'}`);
        for (const d of stillOnline) {
          await api.sendGroup1(d.vk_id, `Непринятый заказ такси #${orderId}! Проверьте диспетчерскую.`);
        }
      } catch (e) { }
    }, 3 * 60 * 1000);
    acceptTimers.set(`t_${orderId}`, timer);
  }
}

// ========== ОБРАБОТКА CALLBACK В ДИСПЕТЧЕРСКОЙ И ЛС ГР1 ==========

/**
 * Обрабатывает callback-нажатия кнопок с payload.disp
 * @param {object} event    VK event (message_event)
 * @param {object} api      { sendGroup1, sendGroup2, sendGroup3, editGroup1, CHATS }
 */
async function handleDispatchCallback(event, api) {
  const payload = typeof event.object.payload === 'string'
    ? JSON.parse(event.object.payload) : event.object.payload;
  if (!payload || !payload.disp) return false;

  const { sendGroup1, sendGroup2, sendGroup3, editGroup1, CHATS } = api;
  const userId = event.object.user_id;
  const peerId = event.object.peer_id;
  const cmid = event.object.conversation_message_id;
  const disp = payload.disp;
  const oid = payload.oid;
  const org = payload.org;

  // --- ПРИНЯТИЕ ЗАКАЗА (из диспетчерской) ---
  if (disp === 'accept') {
    // Отменяем таймер 3 мин
    const timerKey = org === 'taxi' ? `t_${oid}` : `d_${oid}`;
    const timer = acceptTimers.get(timerKey);
    if (timer) { clearTimeout(timer); acceptTimers.delete(timerKey); }

    // Курьер/водитель переходит в ЛС ГР1 для ввода ника и ETA
    const staff = staffGet(userId);
    if (!staff) {
      // Ответ на кнопку
      await answerCallback(event, api);
      await sendGroup1(userId,
        `Для принятия заказа #${oid} вам необходимо сначала создать профиль сотрудника.\n` +
        `Введите "!профиль" для создания.`);
      return true;
    }

    // Проверяем нет ли уже активного заказа
    const activeOrder = org === 'taxi' ? taxiGetByDriver(userId) : orderGetByCourier(userId);
    if (activeOrder && activeOrder.id !== oid) {
      await answerCallback(event, api);
      await sendGroup1(userId, `У вас уже есть активный заказ #${activeOrder.id}. Завершите его сначала.`);
      return true;
    }

    // Редактируем сообщение в диспетчерской
    const order = org === 'taxi' ? taxiGet(oid) : orderGet(oid);
    if (!order || order.status !== 'pending') {
      await answerCallback(event, api);
      return true;
    }

    if (org === 'delivery') {
      const items = require('./db.cjs').orderGetItems(oid);
      const newText = buildDeliveryDispatchText(order, items) + `\n\nПринято: ${staff.nick}`;
      try { await editGroup1(peerId, cmid, newText, {}); } catch (e) { }

      // Запрашиваем ETA в ЛС
      await sendGroup1(userId,
        `Заказ #${oid} принят!\nКлиент: ${order.client_nick}\nМесто: ${order.location}\n\nВведите примерное время ожидания (в минутах):`,
        { keyboard: makeKeyboard([[btn('Отмена', { disp: 'cancel_accept', oid, org: 'delivery' }, 'negative')]]) }
      );

      // Сохраняем состояние: ожидаем ETA
      acceptPending.set(userId, { oid, org: 'delivery', step: 'eta' });

    } else {
      const newText = buildTaxiDispatchText(order) + `\n\nПринято: ${staff.nick}`;
      try { await editGroup1(peerId, cmid, newText, {}); } catch (e) { }

      await sendGroup1(userId,
        `Заказ такси #${oid} принят!\nОткуда: ${order.from_name}\nКуда: ${order.to_name}\nКлиент: ${order.client_nick}\n\nВведите примерное время ожидания (в минутах):`,
        { keyboard: makeKeyboard([[btn('Отмена', { disp: 'cancel_accept', oid, org: 'taxi' }, 'negative')]]) }
      );
      acceptPending.set(userId, { oid, org: 'taxi', step: 'eta' });
    }

    await answerCallback(event, api);
    return true;
  }

  // --- ОТМЕНА ПРИНЯТИЯ ---
  if (disp === 'cancel_accept') {
    acceptPending.delete(userId);
    await sendGroup1(userId, 'Принятие отменено. Заказ возвращён в очередь.');
    return true;
  }

  // --- ОТМЕТКА ТОВАРА КАК КУПЛЕННОГО (помощник курьера) ---
  if (disp === 'toggle_item') {
    const itemId = payload.iid;
    const orderId = payload.oid;
    const db = require('./db.cjs');
    const item = db.db.prepare('SELECT * FROM order_items WHERE id = ?').get(itemId);
    if (!item) return true;
    const newBought = item.bought ? 0 : 1;
    orderItemSetBought(itemId, newBought);
    // Перестроим клавиатуру
    const items = db.orderGetItems(orderId);
    const order = orderGet(orderId);
    if (!order) return true;
    const newText = buildHelperText(order, items);
    const newKb = buildHelperKeyboard(items, orderId, 'delivery');
    try { await editGroup1(peerId, cmid, newText, { keyboard: newKb }); } catch (e) { }
    await answerCallback(event, api);
    return true;
  }

  // --- КУРЬЕР ЕДЕТ К КЛИЕНТУ ---
  if (disp === 'delivering') {
    const order = orderGet(oid);
    if (!order) return true;
    orderUpdate(oid, { status: 'delivering' });
    // Уведомляем клиента
    try {
      await sendGroup2(order.client_vk_id,
        `Ваш заказ готов! Курьер ${order.courier_nick} едет к вам.\nМесто доставки: ${order.location}`);
    } catch (e) { }
    // Обновляем сообщение помощника
    const items = require('./db.cjs').orderGetItems(oid);
    const newText = buildHelperText(order, items) + '\n\n[СТАТУС: Едет к клиенту]';
    const newKb = makeKeyboard([
      [btn('Прибыл к клиенту', { disp: 'arrived', oid }, 'positive')],
    ]);
    try { await editGroup1(peerId, cmid, newText, { keyboard: newKb }); } catch (e) { }
    await answerCallback(event, api);
    return true;
  }

  // --- КУРЬЕР ПРИБЫЛ ---
  if (disp === 'arrived') {
    const order = orderGet(oid);
    if (!order) return true;
    orderUpdate(oid, { status: 'arrived' });
    try {
      await sendGroup2(order.client_vk_id, `Курьер прибыл! ${order.courier_nick} ждёт вас.`);
    } catch (e) { }
    const items = require('./db.cjs').orderGetItems(oid);
    const newText = buildHelperText(order, items) + '\n\n[СТАТУС: Прибыл]';
    const newKb = makeKeyboard([
      [btn('Завершить заказ', { disp: 'done_delivery', oid }, 'positive')],
    ]);
    try { await editGroup1(peerId, cmid, newText, { keyboard: newKb }); } catch (e) { }
    await answerCallback(event, api);
    return true;
  }

  // --- ЗАКАЗ ЗАВЕРШЁН (доставка) ---
  if (disp === 'done_delivery') {
    const order = orderGet(oid);
    if (!order) return true;
    orderUpdate(oid, { status: 'done' });
    // Статистика
    const dateStr = new Date().toISOString().split('T')[0];
    dailyStatsIncrement(dateStr, 'delivery', order.total_price, order.total_cost);
    // Обновляем статистику курьера
    if (order.courier_vk_id) {
      const s = staffGet(order.courier_vk_id);
      if (s) staffUpdate(order.courier_vk_id, { orders_done: s.orders_done + 1, orders_week: s.orders_week + 1 });
    }
    // Уведомляем клиента
    try {
      await sendGroup2(order.client_vk_id,
        `Заказ #${oid} выполнен! Спасибо за покупку.\n\nОтзыв или жалоба: напишите нам в сообщения сообщества.`);
    } catch (e) { }
    const items = require('./db.cjs').orderGetItems(oid);
    const newText = buildHelperText(order, items) + '\n\n[ЗАВЕРШЁН]';
    try { await editGroup1(peerId, cmid, newText, { keyboard: makeKeyboard([]) }); } catch (e) { }
    await answerCallback(event, api);
    return true;
  }

  // === ТАКСИ ===

  // --- ВОДИТЕЛЬ: КЛИЕНТ СЕЛ ---
  if (disp === 'taxi_driving') {
    const order = taxiGet(oid);
    if (!order) return true;
    taxiUpdate(oid, { status: 'driving' });
    try { await sendGroup3(order.client_vk_id, `Поездка началась! Водитель: ${order.driver_nick}`); } catch (e) { }
    const newText = buildTaxiHelperText(order) + '\n\n[СТАТУС: Везём клиента]';
    const newKb = makeKeyboard([
      [btn('Прибыли', { disp: 'taxi_arrived', oid }, 'positive')],
      [btn('Включить платное ожидание', { disp: 'taxi_paid_wait', oid })],
    ]);
    try { await editGroup1(peerId, cmid, newText, { keyboard: newKb }); } catch (e) { }
    await answerCallback(event, api);
    return true;
  }

  // --- ПЛАТНОЕ ОЖИДАНИЕ ---
  if (disp === 'taxi_paid_wait') {
    const order = taxiGet(oid);
    if (!order) return true;
    const waitRate = parseInt(require('./db.cjs').getSetting('taxi_waiting_rate_per_min') || '10');
    taxiUpdate(oid, { status: 'waiting', paid_waiting: (order.paid_waiting || 0) + 1 });
    try {
      await sendGroup3(order.client_vk_id,
        `Водитель ожидает вас. Включено платное ожидание: ${waitRate}р./мин.`);
    } catch (e) { }
    await answerCallback(event, api);
    return true;
  }

  // --- ТАКСИ: ПРИБЫЛИ ---
  if (disp === 'taxi_arrived') {
    const order = taxiGet(oid);
    if (!order) return true;
    taxiUpdate(oid, { status: 'arrived' });
    try { await sendGroup3(order.client_vk_id, 'Вы прибыли в пункт назначения!'); } catch (e) { }
    const newText = buildTaxiHelperText(order) + '\n\n[СТАТУС: Прибыли]';
    const newKb = makeKeyboard([[btn('Завершить поездку', { disp: 'taxi_done', oid }, 'positive')]]);
    try { await editGroup1(peerId, cmid, newText, { keyboard: newKb }); } catch (e) { }
    await answerCallback(event, api);
    return true;
  }

  // --- ТАКСИ: ЗАВЕРШИТЬ ---
  if (disp === 'taxi_done') {
    const order = taxiGet(oid);
    if (!order) return true;
    taxiUpdate(oid, { status: 'done' });
    const dateStr = new Date().toISOString().split('T')[0];
    dailyStatsIncrement(dateStr, 'taxi', order.total_price, 0);
    if (order.driver_vk_id) {
      const s = staffGet(order.driver_vk_id);
      if (s) staffUpdate(order.driver_vk_id, { orders_done: s.orders_done + 1, orders_week: s.orders_week + 1 });
    }
    try {
      await sendGroup3(order.client_vk_id,
        `Поездка #${oid} завершена! Спасибо, что выбрали нас.\nОтзыв или жалоба: напишите нам в сообщения сообщества.`);
    } catch (e) { }
    const newText = buildTaxiHelperText(order) + '\n\n[ЗАВЕРШЕНА]';
    try { await editGroup1(peerId, cmid, newText, { keyboard: makeKeyboard([]) }); } catch (e) { }
    await answerCallback(event, api);
    return true;
  }

  // --- ЗАПРОС ССЫЛКИ НА ЛС (курьеру от клиента) ---
  if (disp === 'client_link_approve') {
    const clientId = payload.cid;
    const orderId = payload.oid;
    const clientLink = `vk.com/im?sel=${clientId}`;
    await sendGroup1(userId, `Ссылка на сообщения клиента: ${clientLink}`);
    try {
      await sendGroup2(clientId, `Курьер одобрил запрос.\nСсылка на сообщения курьера: vk.com/im?sel=${userId}`);
    } catch (e) { }
    await answerCallback(event, api);
    return true;
  }
  if (disp === 'client_link_deny') {
    const clientId = payload.cid;
    try {
      await sendGroup2(clientId, 'Курьер отклонил запрос на связь.');
    } catch (e) { }
    await answerCallback(event, api);
    return true;
  }

  // --- ТО ЖЕ ДЛЯ ТАКСИ ---
  if (disp === 'client_link_approve_taxi') {
    const clientId = payload.cid;
    const clientLink = `vk.com/im?sel=${clientId}`;
    await sendGroup1(userId, `Ссылка на сообщения клиента: ${clientLink}`);
    try {
      await sendGroup3(clientId, `Водитель одобрил запрос.\nСсылка: vk.com/im?sel=${userId}`);
    } catch (e) { }
    await answerCallback(event, api);
    return true;
  }
  if (disp === 'client_link_deny_taxi') {
    const clientId = payload.cid;
    try {
      await sendGroup3(clientId, 'Водитель отклонил запрос на связь.');
    } catch (e) { }
    await answerCallback(event, api);
    return true;
  }

  return false;
}

// Состояния ожидания ввода от курьера (ETA)
const acceptPending = new Map();

/**
 * Обрабатывает текстовые сообщения от курьеров в ЛС ГР1
 * (ввод ETA после принятия заказа)
 */
async function handleCourierInput(vkMsg, api) {
  const { sendGroup1, sendGroup2, sendGroup3, editGroup1, CHATS } = api;
  const userId = vkMsg.from_id;
  const text = (vkMsg.text || '').trim();

  const pending = acceptPending.get(userId);
  if (!pending) return false;

  if (pending.step === 'eta') {
    const eta = parseInt(text);
    if (isNaN(eta) || eta <= 0 || eta > 300) {
      await sendGroup1(userId, 'Введите корректное время ожидания (в минутах, от 1 до 300):');
      return true;
    }

    const staff = staffGet(userId);
    const nick = staff ? staff.nick : `id${userId}`;

    if (pending.org === 'delivery') {
      const order = orderGet(pending.oid);
      if (!order) { acceptPending.delete(userId); return true; }
      orderUpdate(pending.oid, {
        status: 'accepted',
        courier_vk_id: userId,
        courier_nick: nick,
        eta_minutes: eta,
      });
      acceptPending.delete(userId);

      // Уведомляем клиента ГР2
      try {
        await sendGroup2(order.client_vk_id,
          `Ваш заказ принят!\nКурьер: ${nick}\nПримерное время ожидания: ${eta} минут.`);
      } catch (e) { }

      // Отправляем помощника курьеру
      const items = require('./db.cjs').orderGetItems(pending.oid);
      const helperText = buildHelperText(order, items);
      const helperKb = buildHelperKeyboard(items, pending.oid, 'delivery');
      const helperMsgId = await sendGroup1(userId, helperText, { keyboard: helperKb });
      if (helperMsgId) orderUpdate(pending.oid, { helper_msg_id: helperMsgId });

    } else {
      const order = taxiGet(pending.oid);
      if (!order) { acceptPending.delete(userId); return true; }
      taxiUpdate(pending.oid, {
        status: 'accepted',
        driver_vk_id: userId,
        driver_nick: nick,
      });
      acceptPending.delete(userId);

      // Уведомляем клиента ГР3
      try {
        await sendGroup3(order.client_vk_id,
          `Ваш заказ такси принят!\nВодитель: ${nick}\nПримерное время: ${eta} минут.`);
      } catch (e) { }

      // Помощник водителя
      const helperText = buildTaxiHelperText(order);
      const helperKb = buildTaxiHelperKeyboard(pending.oid);
      await sendGroup1(userId, helperText, { keyboard: helperKb });
    }
    return true;
  }
  return false;
}

// ========== ЗАПРОСЫ СВЯЗИ КЛИЕНТ↔КУРЬЕР ==========

async function notifyCourierLinkRequest(order, clientId, api) {
  const { sendGroup1 } = api;
  const kb = makeKeyboard([
    [btn('Одобрить', { disp: 'client_link_approve', oid: order.id, cid: clientId }, 'positive')],
    [btn('Отклонить', { disp: 'client_link_deny', oid: order.id, cid: clientId }, 'negative')],
  ]);
  try {
    await sendGroup1(order.courier_vk_id,
      `Клиент ${order.client_nick} запрашивает ссылку на ваши сообщения. Одобрить?`,
      { keyboard: kb });
  } catch (e) { }
}

async function notifyDriverLinkRequest(order, clientId, api) {
  const { sendGroup1 } = api;
  const kb = makeKeyboard([
    [btn('Одобрить', { disp: 'client_link_approve_taxi', oid: order.id, cid: clientId }, 'positive')],
    [btn('Отклонить', { disp: 'client_link_deny_taxi', oid: order.id, cid: clientId }, 'negative')],
  ]);
  try {
    await sendGroup1(order.driver_vk_id,
      `Клиент ${order.client_nick} запрашивает ссылку на ваши сообщения. Одобрить?`,
      { keyboard: kb });
  } catch (e) { }
}

// Курьер запрашивает ссылку на клиента (ему без вопросов)
async function giveCourierClientLink(order, courierId, api) {
  const { sendGroup1 } = api;
  const link = `vk.com/im?sel=${order.client_vk_id}`;
  await sendGroup1(courierId, `Ссылка на сообщения клиента: ${link}`);
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ==========

function buildTaxiHelperText(order) {
  const passengers = JSON.parse(order.passengers || '[]');
  let text = `Помощник водителя | Поездка #${order.id}\n`;
  text += `Клиент: ${order.client_nick}\n`;
  if (passengers.length > 0) text += `Попутчики: ${passengers.join(', ')}\n`;
  text += `Откуда: ${order.from_name}\nКуда: ${order.to_name}\n`;
  text += `Расстояние: ${order.distance_km} км\nСтоимость: ${order.total_price}р.`;
  return text;
}

async function answerCallback(event, api) {
  try {
    await api.callGroup1('messages.sendMessageEventAnswer', {
      event_id: event.object.event_id,
      user_id: event.object.user_id,
      peer_id: event.object.peer_id,
    });
  } catch (e) { }
}

function safeJson(str, def) {
  try { return typeof str === 'string' ? JSON.parse(str) : (str || def); } catch (e) { return def; }
}

module.exports = {
  notifyDispatch,
  handleDispatchCallback,
  handleCourierInput,
  notifyCourierLinkRequest,
  notifyDriverLinkRequest,
  giveCourierClientLink,
  acceptPending,
};
