/**
 * bot-taxi-client.cjs
 * Обрабатывает ЛС Группы 3 (клиенты такси)
 *
 * Состояния:
 *  IDLE
 *  MAIN_MENU
 *  TAXI_NICK          ввод никнейма
 *  TAXI_PASSENGERS    добавление попутчиков (до 2)
 *  TAXI_FROM_CITY     выбор города "Откуда"
 *  TAXI_FROM_CAT      выбор категории "Откуда"
 *  TAXI_FROM_POINT    выбор точки "Откуда"
 *  TAXI_TO_CITY       выбор города "Куда"
 *  TAXI_TO_CAT        выбор категории "Куда"
 *  TAXI_TO_POINT      выбор точки "Куда"
 *  TAXI_PROMO         ввод промокода
 *  TAXI_PAYMENT       выбор оплаты
 *  TAXI_PAYMENT_PROOF ожидание скрина (банк/телефон)
 *  TAXI_WAITING       ждём водителя
 *  TAXI_ACTIVE        заказ принят
 *  FAQ
 *  EMPLOYMENT
 */

const {
  mapCityGetAll, mapCityGet,
  mapCategoryGetAll, mapCategoryGet,
  mapPointsByCity, mapPointsByCategory, mapPointGet,
  calcTaxiPrice,
  taxiCreate, taxiGet, taxiUpdate, taxiGetByClient,
  promoGet, promoUse, applyPromo,
  getSetting,
} = require('./db.cjs');

const sessions = new Map();
const activeMsg = new Map();

const TEXT_FAQ = `Частые вопросы:

— Как заказать такси?
Нажмите "Заказать авто" и следуйте инструкциям.

— Можно взять попутчика?
Да, при оформлении можно добавить до 2 попутчиков.

— Как рассчитывается стоимость?
По расстоянию между точками. В часы пик применяется коэффициент.

— Способы оплаты?
Наличными, банковский перевод (комиссия 5%) или через телефон (комиссия 7%).

— Платное ожидание?
Если водитель ждёт более 5 минут — может включить платное ожидание.`;

const TEXT_EMPLOYMENT = `Трудоустройство:

Мы ищем водителей!

Требования:
— Наличие личного автомобиля
— Водительское удостоверение
— Вежливость и пунктуальность

Для подачи заявки напишите нам в сообщения сообщества.`;

// ========== УТИЛИТЫ ==========

function getSession(vkId) {
  if (!sessions.has(vkId)) sessions.set(vkId, { state: 'IDLE', data: {} });
  return sessions.get(vkId);
}

function setSession(vkId, state, data = {}) {
  sessions.set(vkId, { state, data });
}

function btn(label, payload, color = 'default') {
  return { action: { type: 'callback', label, payload: JSON.stringify(payload) }, color };
}

function makeKeyboard(rows, inline = true) {
  return JSON.stringify({ inline, buttons: rows });
}

async function editOrSend(userId, peerId, text, params, sendMsg, editMsg) {
  const cmid = activeMsg.get(userId);
  if (cmid && editMsg) {
    try {
      await editMsg(peerId, cmid, text, params);
      return cmid;
    } catch (e) { /* fallthrough */ }
  }
  if (sendMsg) {
    const newCmid = await sendMsg(peerId, text, params);
    if (newCmid) activeMsg.set(userId, newCmid);
    return newCmid;
  }
}

// ========== КЛАВИАТУРЫ ==========

function mainMenuKeyboard(hasActive = false) {
  const rows = [
    [btn('Заказать авто', { tc: 'order' })],
    [btn('Трудоустройство', { tc: 'employment' }), btn('Частые вопросы', { tc: 'faq' })],
  ];
  if (hasActive) rows.unshift([btn('Статус поездки', { tc: 'status' }, 'positive')]);
  return makeKeyboard(rows);
}

function cityKeyboard(cities, forField) {
  const rows = [];
  for (let i = 0; i < cities.length; i += 2) {
    const row = [btn(cities[i].name, { tc: 'city', id: cities[i].id, for: forField })];
    if (cities[i + 1]) row.push(btn(cities[i + 1].name, { tc: 'city', id: cities[i + 1].id, for: forField }));
    rows.push(row);
  }
  rows.push([btn('Назад', { tc: 'back' }, 'negative')]);
  return makeKeyboard(rows);
}

function catKeyboard(cats, cityId, forField) {
  const rows = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row = [btn(cats[i].name, { tc: 'cat', id: cats[i].id, city: cityId, for: forField })];
    if (cats[i + 1]) row.push(btn(cats[i + 1].name, { tc: 'cat', id: cats[i + 1].id, city: cityId, for: forField }));
    rows.push(row);
  }
  rows.push([btn('Назад', { tc: 'back_city', for: forField }, 'negative')]);
  return makeKeyboard(rows);
}

function pointKeyboard(points, forField) {
  const rows = [];
  for (let i = 0; i < points.length; i += 2) {
    const row = [btn(points[i].name, { tc: 'point', id: points[i].id, for: forField })];
    if (points[i + 1]) row.push(btn(points[i + 1].name, { tc: 'point', id: points[i + 1].id, for: forField }));
    rows.push(row);
  }
  rows.push([btn('Назад', { tc: 'back_cat', for: forField }, 'negative')]);
  return makeKeyboard(rows);
}

function passengersKeyboard(count) {
  const rows = [];
  if (count === 0) {
    rows.push([btn('Добавить попутчика', { tc: 'add_passenger' })]);
  } else if (count === 1) {
    rows.push([btn('Добавить ещё попутчика', { tc: 'add_passenger' })]);
  }
  rows.push([btn('Продолжить без попутчиков', { tc: 'skip_passengers' }, 'secondary')]);
  rows.push([btn('Назад', { tc: 'back_nick' }, 'negative')]);
  return makeKeyboard(rows);
}

function promoKeyboard() {
  return makeKeyboard([
    [btn('Пропустить', { tc: 'skip_promo' }, 'secondary')],
    [btn('Назад', { tc: 'back_route' }, 'negative')],
  ]);
}

function paymentKeyboard() {
  return makeKeyboard([
    [btn('Наличными', { tc: 'pay_cash' }, 'positive')],
    [btn('Банковский счёт (-5%)', { tc: 'pay_bank' })],
    [btn('Телефон (-7%)', { tc: 'pay_phone' })],
    [btn('Назад', { tc: 'back_promo' }, 'negative')],
  ]);
}

function activeOrderKeyboard(orderId) {
  return makeKeyboard([
    [btn('Статус поездки', { tc: 'status' }, 'positive')],
    [btn('Связь с водителем', { tc: 'driver_link', oid: orderId })],
    [btn('Главное меню', { tc: 'main' }, 'secondary')],
  ]);
}

// ========== ГЛАВНЫЙ ОБРАБОТЧИК ==========

async function handleTaxiClient(vkMsg, sendMsg, editMsg, notifyDispatch, botCtx) {
  const userId = vkMsg.from_id;
  const peerId = vkMsg.peer_id;
  const text = (vkMsg.text || '').trim();
  const session = getSession(userId);

  if (vkMsg._callbackPayload) {
    return await handleTaxiCallback(userId, peerId, vkMsg._callbackPayload, session, sendMsg, editMsg, notifyDispatch, botCtx, vkMsg);
  }

  // Текстовые состояния
  if (session.state === 'TAXI_NICK') {
    return await handleNickInput(userId, peerId, text, session, sendMsg, editMsg);
  }
  if (session.state === 'TAXI_PASSENGERS') {
    return await handlePassengerInput(userId, peerId, text, session, sendMsg, editMsg);
  }
  if (session.state === 'TAXI_PROMO') {
    return await handlePromoInput(userId, peerId, text, session, sendMsg, editMsg);
  }
  if (session.state === 'TAXI_PAYMENT_PROOF') {
    return await handlePaymentProof(userId, peerId, vkMsg, session, sendMsg, editMsg, notifyDispatch);
  }

  if (text.toLowerCase() === 'начать' || session.state === 'IDLE') {
    return await showMainMenu(userId, peerId, sendMsg);
  }

  return await showMainMenu(userId, peerId, sendMsg);
}

// ============ CALLBACK HANDLER ============

async function handleTaxiCallback(userId, peerId, p, session, sendMsg, editMsg, notifyDispatch, botCtx, vkMsg) {
  const tc = p.tc;

  switch (tc) {
    // ---- ГЛАВНОЕ МЕНЮ ----
    case 'main':
      return await showMainMenu(userId, peerId, sendMsg);

    case 'employment':
      setSession(userId, 'EMPLOYMENT');
      return await editOrSend(userId, peerId, TEXT_EMPLOYMENT,
        { keyboard: makeKeyboard([[btn('Назад', { tc: 'main' }, 'negative')]]) },
        sendMsg, editMsg);

    case 'faq':
      setSession(userId, 'FAQ');
      return await editOrSend(userId, peerId, TEXT_FAQ,
        { keyboard: makeKeyboard([[btn('Назад', { tc: 'main' }, 'negative')]]) },
        sendMsg, editMsg);

    // ---- ЗАКАЗ — НАЧАЛО ----
    case 'order':
      setSession(userId, 'TAXI_NICK', {});
      return await editOrSend(userId, peerId,
        'Заказ такси\n\nВведите ваш никнейм:',
        { keyboard: makeKeyboard([[btn('Отмена', { tc: 'main' }, 'negative')]]) },
        sendMsg, editMsg);

    case 'back_nick':
      setSession(userId, 'TAXI_NICK', session.data);
      return await editOrSend(userId, peerId,
        'Введите ваш никнейм:',
        { keyboard: makeKeyboard([[btn('Отмена', { tc: 'main' }, 'negative')]]) },
        sendMsg, editMsg);

    // ---- ПОПУТЧИКИ ----
    case 'add_passenger': {
      const count = (session.data.passengers || []).length;
      if (count >= 2) {
        return await editOrSend(userId, peerId,
          buildPassengerText(session.data) + '\n\nМаксимум 2 попутчика.',
          { keyboard: passengersKeyboard(count) }, sendMsg, editMsg);
      }
      // Ждём ввода никнейма попутчика
      setSession(userId, 'TAXI_PASSENGERS', { ...session.data, addingPassenger: true });
      return await editOrSend(userId, peerId,
        buildPassengerText(session.data) + '\n\nВведите никнейм попутчика:',
        { keyboard: makeKeyboard([[btn('Отмена', { tc: 'skip_passengers' }, 'secondary')]]) },
        sendMsg, editMsg);
    }

    case 'skip_passengers': {
      setSession(userId, 'TAXI_FROM_CITY', { ...session.data });
      return await showFromCitySelection(userId, peerId, sendMsg, editMsg);
    }

    // ---- ВЫБОР ГОРОДА ----
    case 'city': {
      const forField = p.for;
      const city = mapCityGet(p.id);
      if (!city) return;
      if (forField === 'from') {
        setSession(userId, 'TAXI_FROM_CAT', { ...session.data, fromCityId: p.id, fromCityName: city.name });
        return await showFromCatSelection(userId, peerId, p.id, sendMsg, editMsg);
      } else {
        setSession(userId, 'TAXI_TO_CAT', { ...session.data, toCityId: p.id, toCityName: city.name });
        return await showToCatSelection(userId, peerId, p.id, sendMsg, editMsg);
      }
    }

    case 'back_city': {
      const forField = p.for;
      if (forField === 'from') {
        return await showFromCitySelection(userId, peerId, sendMsg, editMsg);
      } else {
        return await showToCitySelection(userId, peerId, sendMsg, editMsg);
      }
    }

    // ---- ВЫБОР КАТЕГОРИИ ТОЧКИ ----
    case 'cat': {
      const forField = p.for;
      const cat = mapCategoryGet(p.id);
      if (!cat) return;
      if (forField === 'from') {
        setSession(userId, 'TAXI_FROM_POINT', { ...session.data, fromCatId: p.id, fromCatName: cat.name });
        return await showFromPointSelection(userId, peerId, session.data.fromCityId || p.city, p.id, sendMsg, editMsg);
      } else {
        setSession(userId, 'TAXI_TO_POINT', { ...session.data, toCatId: p.id, toCatName: cat.name });
        return await showToPointSelection(userId, peerId, session.data.toCityId || p.city, p.id, sendMsg, editMsg);
      }
    }

    case 'back_cat': {
      const forField = p.for;
      const d = session.data;
      if (forField === 'from') {
        return await showFromCatSelection(userId, peerId, d.fromCityId, sendMsg, editMsg);
      } else {
        return await showToCatSelection(userId, peerId, d.toCityId, sendMsg, editMsg);
      }
    }

    // ---- ВЫБОР ТОЧКИ ----
    case 'point': {
      const forField = p.for;
      const point = mapPointGet(p.id);
      if (!point) return;
      const d = session.data;
      if (forField === 'from') {
        const newData = { ...d, fromPointId: p.id, fromPointName: point.name };
        setSession(userId, 'TAXI_TO_CITY', newData);
        return await showToCitySelection(userId, peerId, sendMsg, editMsg);
      } else {
        const newData = { ...d, toPointId: p.id, toPointName: point.name };
        // Считаем стоимость
        const priceInfo = calcTaxiPrice(newData.fromPointId, p.id);
        newData.priceInfo = priceInfo;
        setSession(userId, 'TAXI_PROMO', newData);
        return await showRouteConfirm(userId, peerId, newData, sendMsg, editMsg);
      }
    }

    // ---- ПРОМОКОД ----
    case 'skip_promo': {
      setSession(userId, 'TAXI_PAYMENT', { ...session.data, promoDiscount: 0 });
      return await showPaymentSelection(userId, peerId, session.data, 0, sendMsg, editMsg);
    }

    case 'back_route': {
      setSession(userId, 'TAXI_TO_POINT', session.data);
      return await showToPointSelection(userId, peerId, session.data.toCityId, session.data.toCatId, sendMsg, editMsg);
    }

    case 'back_promo': {
      setSession(userId, 'TAXI_PROMO', session.data);
      return await showRouteConfirm(userId, peerId, session.data, sendMsg, editMsg);
    }

    // ---- ОПЛАТА ----
    case 'pay_cash': {
      const d = session.data;
      const discount = d.promoDiscount || 0;
      const total = (d.priceInfo?.price || 0) - discount;
      const orderId = await createTaxiOrder(userId, d, 'cash', null, total);
      setSession(userId, 'TAXI_WAITING', { orderId });
      await notifyDispatch({ orderId, org: 'taxi' });
      const text = buildTaxiSummary(d, discount) + '\n\nОплата наличными водителю.\n\nОжидайте принятия заказа...';
      return await editOrSend(userId, peerId, text, { keyboard: makeKeyboard([[btn('Главное меню', { tc: 'main' })]]) }, sendMsg, editMsg);
    }

    case 'pay_bank': {
      const d = session.data;
      const discount = d.promoDiscount || 0;
      const rawTotal = (d.priceInfo?.price || 0) - discount;
      const commPct = parseInt(getSetting('bank_commission_pct') || '5');
      const totalWithComm = Math.ceil(rawTotal * (1 + commPct / 100));
      const bankAcc = getSetting('bank_account') || '852006';
      setSession(userId, 'TAXI_PAYMENT_PROOF', { ...d, payType: 'bank', totalWithComm, rawTotal });
      return await editOrSend(userId, peerId,
        buildTaxiSummary(d, discount) +
        `\n\nКомиссия ${commPct}%.\nПереведите ${totalWithComm}р. на счёт ${bankAcc}.\n\nПришлите скрин оплаты:`,
        { keyboard: makeKeyboard([[btn('Отмена', { tc: 'main' }, 'negative')]]) }, sendMsg, editMsg);
    }

    case 'pay_phone': {
      const d = session.data;
      const discount = d.promoDiscount || 0;
      const rawTotal = (d.priceInfo?.price || 0) - discount;
      const commPct = parseInt(getSetting('phone_commission_pct') || '7');
      const totalWithComm = Math.ceil(rawTotal * (1 + commPct / 100));
      const bankAcc = getSetting('bank_account') || '852006';
      setSession(userId, 'TAXI_PAYMENT_PROOF', { ...d, payType: 'phone', totalWithComm, rawTotal });
      return await editOrSend(userId, peerId,
        buildTaxiSummary(d, discount) +
        `\n\nКомиссия ${commPct}%.\nПереведите ${totalWithComm}р. на номер телефона.\n\nПришлите скрин с /timestamp в чате:`,
        { keyboard: makeKeyboard([[btn('Отмена', { tc: 'main' }, 'negative')]]) }, sendMsg, editMsg);
    }

    // ---- СТАТУС ----
    case 'status': {
      const active = taxiGetByClient(userId);
      if (!active) {
        return await editOrSend(userId, peerId, 'Нет активных поездок.',
          { keyboard: makeKeyboard([[btn('Главное меню', { tc: 'main' })]]) }, sendMsg, editMsg);
      }
      return await editOrSend(userId, peerId,
        buildTaxiStatusText(active),
        { keyboard: activeOrderKeyboard(active.id) }, sendMsg, editMsg);
    }

    // ---- ССЫЛКА НА ВОДИТЕЛЯ ----
    case 'driver_link': {
      const order = taxiGet(p.oid);
      if (!order || !order.driver_vk_id) {
        return await editOrSend(userId, peerId, 'Водитель ещё не назначен.',
          { keyboard: activeOrderKeyboard(p.oid) }, sendMsg, editMsg);
      }
      return await editOrSend(userId, peerId,
        'Уверены, что хотите связаться с водителем?\nЗапрос будет отправлен ему.',
        { keyboard: makeKeyboard([[btn('Да', { tc: 'driver_link_confirm', oid: p.oid }, 'positive'), btn('Нет', { tc: 'status' }, 'negative')]]) },
        sendMsg, editMsg);
    }

    case 'driver_link_confirm': {
      const order = taxiGet(p.oid);
      if (!order || !order.driver_vk_id) return;
      if (botCtx && botCtx.notifyDriverLinkRequest) {
        await botCtx.notifyDriverLinkRequest(order, userId);
      }
      return await editOrSend(userId, peerId,
        'Запрос отправлен водителю. Ожидайте его ответа.',
        { keyboard: activeOrderKeyboard(p.oid) }, sendMsg, editMsg);
    }

    default:
      return await showMainMenu(userId, peerId, sendMsg);
  }
}

// ============ ТЕКСТОВЫЕ СОСТОЯНИЯ ============

async function handleNickInput(userId, peerId, text, session, sendMsg, editMsg) {
  if (!text || text.length < 2) {
    await sendMsg(peerId, 'Введите корректный никнейм (минимум 2 символа).');
    return;
  }
  const newData = { ...session.data, nick: text, passengers: [] };
  setSession(userId, 'TAXI_PASSENGERS', newData);
  await editOrSend(userId, peerId,
    buildPassengerText(newData) + '\n\nМожно добавить до 2 попутчиков:',
    { keyboard: passengersKeyboard(0) }, sendMsg, editMsg);
}

async function handlePassengerInput(userId, peerId, text, session, sendMsg, editMsg) {
  if (!text || text.length < 2) {
    await sendMsg(peerId, 'Введите никнейм попутчика.');
    return;
  }
  const passengers = [...(session.data.passengers || []), text.trim()];
  const newData = { ...session.data, passengers, addingPassenger: false };
  setSession(userId, 'TAXI_PASSENGERS', newData);
  await editOrSend(userId, peerId,
    buildPassengerText(newData) + '\n\nЕщё добавить попутчика?',
    { keyboard: passengersKeyboard(passengers.length) }, sendMsg, editMsg);
}

async function handlePromoInput(userId, peerId, text, session, sendMsg, editMsg) {
  const d = session.data;
  const rawTotal = d.priceInfo?.price || 0;
  const code = text.trim().toUpperCase();
  const result = applyPromo(code, 'taxi', { items: [], total: rawTotal });
  if (!result.ok) {
    await editOrSend(userId, peerId,
      buildRouteConfirmText(d, 0) + '\n\n' + result.msg + '\n\nВведите промокод или пропустите:',
      { keyboard: promoKeyboard() }, sendMsg, editMsg);
    return;
  }
  const discount = result.discount || 0;
  setSession(userId, 'TAXI_PAYMENT', { ...d, promoCode: code, promoDiscount: discount });
  await editOrSend(userId, peerId,
    buildRouteConfirmText(d, discount) + `\n\nПромокод "${code}" применён, скидка ${discount}р.\n\nВыберите способ оплаты:`,
    { keyboard: paymentKeyboard() }, sendMsg, editMsg);
}

async function handlePaymentProof(userId, peerId, vkMsg, session, sendMsg, editMsg, notifyDispatch) {
  const hasPhoto = vkMsg.attachments && vkMsg.attachments.some(a => a.type === 'photo');
  if (!hasPhoto) {
    await sendMsg(peerId, 'Пожалуйста, пришлите скрин оплаты фотографией.');
    return;
  }
  const d = session.data;
  const photoAtt = vkMsg.attachments.find(a => a.type === 'photo');
  const photoId = `photo${photoAtt.photo.owner_id}_${photoAtt.photo.id}`;
  const discount = d.promoDiscount || 0;
  const total = d.rawTotal - discount;
  const orderId = await createTaxiOrder(userId, d, d.payType, photoId, total);
  setSession(userId, 'TAXI_WAITING', { orderId });
  await notifyDispatch({ orderId, org: 'taxi' });
  await editOrSend(userId, peerId,
    buildTaxiSummary(d, discount) + '\n\nСкрин получен. Ожидайте принятия заказа...',
    { keyboard: makeKeyboard([[btn('Главное меню', { tc: 'main' })]]) }, sendMsg, editMsg);
}

// ============ ЭКРАНЫ ============

async function showMainMenu(userId, peerId, sendMsg) {
  setSession(userId, 'MAIN_MENU', {});
  const active = taxiGetByClient(userId);
  const msgId = await sendMsg(peerId, 'Главное меню\n\nВыберите раздел:',
    { keyboard: mainMenuKeyboard(!!active) });
  if (msgId) activeMsg.set(userId, msgId);
}

async function showFromCitySelection(userId, peerId, sendMsg, editMsg) {
  const cities = mapCityGetAll();
  if (cities.length === 0) {
    return await editOrSend(userId, peerId, 'Точки карты ещё не добавлены. Обратитесь к администратору.',
      { keyboard: makeKeyboard([[btn('Главное меню', { tc: 'main' })]]) }, sendMsg, editMsg);
  }
  const d = getSession(userId).data;
  const text = buildPassengerText(d) + '\n\nВыберите город "Откуда":';
  return await editOrSend(userId, peerId, text, { keyboard: cityKeyboard(cities, 'from') }, sendMsg, editMsg);
}

async function showToCitySelection(userId, peerId, sendMsg, editMsg) {
  const cities = mapCityGetAll();
  const d = getSession(userId).data;
  const text = buildPassengerText(d) + `\n\nОткуда: ${d.fromPointName || '—'}\n\nВыберите город "Куда":`;
  return await editOrSend(userId, peerId, text, { keyboard: cityKeyboard(cities, 'to') }, sendMsg, editMsg);
}

async function showFromCatSelection(userId, peerId, cityId, sendMsg, editMsg) {
  const d = getSession(userId).data;
  // Получаем уникальные категории для точек этого города
  const points = mapPointsByCity(cityId);
  const catIds = [...new Set(points.map(p => p.category_id))];
  const cats = catIds.map(id => mapCategoryGet(id)).filter(Boolean);
  if (cats.length === 0) {
    return await editOrSend(userId, peerId, `В городе "${d.fromCityName}" нет точек.`,
      { keyboard: makeKeyboard([[btn('Назад', { tc: 'back_city', for: 'from' }, 'negative')]]) }, sendMsg, editMsg);
  }
  return await editOrSend(userId, peerId,
    buildPassengerText(d) + `\n\nГород: ${d.fromCityName}\nВыберите категорию "Откуда":`,
    { keyboard: catKeyboard(cats, cityId, 'from') }, sendMsg, editMsg);
}

async function showToCatSelection(userId, peerId, cityId, sendMsg, editMsg) {
  const d = getSession(userId).data;
  const points = mapPointsByCity(cityId);
  const catIds = [...new Set(points.map(p => p.category_id))];
  const cats = catIds.map(id => mapCategoryGet(id)).filter(Boolean);
  if (cats.length === 0) {
    return await editOrSend(userId, peerId, `В городе "${d.toCityName}" нет точек.`,
      { keyboard: makeKeyboard([[btn('Назад', { tc: 'back_city', for: 'to' }, 'negative')]]) }, sendMsg, editMsg);
  }
  return await editOrSend(userId, peerId,
    buildPassengerText(d) + `\n\nОткуда: ${d.fromPointName}\nГород: ${d.toCityName}\nВыберите категорию "Куда":`,
    { keyboard: catKeyboard(cats, cityId, 'to') }, sendMsg, editMsg);
}

async function showFromPointSelection(userId, peerId, cityId, catId, sendMsg, editMsg) {
  const d = getSession(userId).data;
  const points = mapPointsByCategory(cityId, catId);
  if (points.length === 0) {
    return await editOrSend(userId, peerId, 'В выбранной категории нет точек.',
      { keyboard: makeKeyboard([[btn('Назад', { tc: 'back_cat', for: 'from' }, 'negative')]]) }, sendMsg, editMsg);
  }
  return await editOrSend(userId, peerId,
    buildPassengerText(d) + `\n\nВыберите точку "Откуда":`,
    { keyboard: pointKeyboard(points, 'from') }, sendMsg, editMsg);
}

async function showToPointSelection(userId, peerId, cityId, catId, sendMsg, editMsg) {
  const d = getSession(userId).data;
  const points = mapPointsByCategory(cityId, catId);
  if (points.length === 0) {
    return await editOrSend(userId, peerId, 'В выбранной категории нет точек.',
      { keyboard: makeKeyboard([[btn('Назад', { tc: 'back_cat', for: 'to' }, 'negative')]]) }, sendMsg, editMsg);
  }
  return await editOrSend(userId, peerId,
    buildPassengerText(d) + `\n\nОткуда: ${d.fromPointName}\nВыберите точку "Куда":`,
    { keyboard: pointKeyboard(points, 'to') }, sendMsg, editMsg);
}

async function showRouteConfirm(userId, peerId, d, sendMsg, editMsg) {
  const text = buildRouteConfirmText(d, 0) + '\n\nЕсть промокод? Введите его или нажмите "Пропустить":';
  return await editOrSend(userId, peerId, text, { keyboard: promoKeyboard() }, sendMsg, editMsg);
}

async function showPaymentSelection(userId, peerId, d, discount, sendMsg, editMsg) {
  const text = buildRouteConfirmText(d, discount) + '\n\nВыберите способ оплаты:';
  return await editOrSend(userId, peerId, text, { keyboard: paymentKeyboard() }, sendMsg, editMsg);
}

// ============ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ============

function buildPassengerText(d) {
  let text = `Никнейм: ${d.nick || '—'}`;
  if (d.passengers && d.passengers.length > 0) {
    text += '\nПопутчики: ' + d.passengers.join(', ');
  }
  return text;
}

function buildRouteConfirmText(d, discount) {
  const info = d.priceInfo || {};
  const rawPrice = info.price || 0;
  const finalPrice = rawPrice - (discount || 0);
  let text = buildPassengerText(d);
  text += `\n\nОткуда: ${d.fromPointName || '—'}`;
  text += `\nКуда: ${d.toPointName || '—'}`;
  text += `\nРасстояние: ${info.distance || 0} км`;
  if (info.isPeak) text += '\n(Часы пик: коэффициент применён)';
  if (discount > 0) text += `\nСкидка: -${discount}р.`;
  text += `\nСтоимость: ${finalPrice}р.`;
  return text;
}

function buildTaxiSummary(d, discount) {
  return buildRouteConfirmText(d, discount);
}

function buildTaxiStatusText(order) {
  const statuses = {
    pending:    'Ожидаем водителя...',
    accepted:   `Водитель: ${order.driver_nick}\nЕдет к вам.`,
    waiting:    `Водитель ожидает вас (${order.paid_waiting > 0 ? 'платное ожидание' : 'бесплатно'}).`,
    driving:    `В пути. Водитель: ${order.driver_nick}`,
    arrived:    'Водитель прибыл в пункт назначения!',
    done:       'Поездка завершена. Спасибо!',
    cancelled:  'Заказ отменён.',
  };
  return `Статус поездки #${order.id}:\n${statuses[order.status] || order.status}`;
}

async function createTaxiOrder(userId, d, payType, payProof, total) {
  const discount = d.promoDiscount || 0;
  const orderId = taxiCreate({
    client_vk_id: userId,
    client_nick: d.nick,
    passengers: JSON.stringify(d.passengers || []),
    from_point_id: d.fromPointId,
    to_point_id: d.toPointId,
    from_name: d.fromPointName,
    to_name: d.toPointName,
    distance_km: d.priceInfo?.distance || 0,
    payment_type: payType,
    payment_proof: payProof || null,
    promo_code: d.promoCode || null,
    discount_amt: discount,
    total_price: total,
    cart_msg_id: null,
  });
  if (d.promoCode) promoUse(d.promoCode);
  return orderId;
}

module.exports = {
  handleTaxiClient,
  getSession,
  setSession,
  activeMsg,
  buildTaxiStatusText,
};
