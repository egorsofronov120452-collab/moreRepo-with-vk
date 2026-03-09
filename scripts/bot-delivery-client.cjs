/**
 * bot-delivery-client.cjs
 * Обрабатывает ЛС Группы 2 (клиенты доставки)
 *
 * Состояния (хранятся в памяти, ключ = vk_id клиента):
 *  IDLE              нет активной сессии
 *  MAIN_MENU         главное меню
 *  CATALOG_CATS      выбор категории каталога
 *  CATALOG_ITEMS     просмотр товаров категории
 *  CART              корзина
 *  ORDER_NICK        ввод никнейма
 *  ORDER_LOCATION    ввод места доставки
 *  ORDER_CONFIRM     подтверждение заказа
 *  ORDER_PROMO       ввод промокода
 *  ORDER_PROMO_CATEGORY  выбор бесплатного товара из категории
 *  ORDER_PAYMENT     выбор способа оплаты
 *  ORDER_PAYMENT_PROOF   ожидание скрина оплаты
 *  ORDER_WAITING     заказ отправлен, ожидание курьера
 *  ORDER_ACTIVE      заказ принят (можно смотреть статус и запрашивать ссылку курьера)
 *  FAQ               частые вопросы
 *  EMPLOYMENT        трудоустройство
 */

const {
  categoryGetAll, categoryGet,
  productGetAll, productGet,
  setGetAll, setGet, setItems,
  orderCreate, orderAddItem, orderGet, orderGetItems, orderUpdate,
  orderGetByClient,
  promoGet, promoUse, applyPromo,
  staffGet,
} = require('./db.cjs');

// Состояния клиентских сессий: vkId -> sessionObject
const sessions = new Map();

// Временные корзины: vkId -> { items: [], orderMsgId: null }
const carts = new Map();

// ID последнего "живого" сообщения бота у клиента (для редактирования)
// vkId -> conversation_message_id
const activeMsg = new Map();

// Тексты
const TEXT_FAQ = `Частые вопросы:

— Как сделать заказ?
Нажмите "Заказать" в главном меню и следуйте инструкциям.

— Как отслеживать заказ?
После оформления в главном меню появится кнопка "Статус заказа".

— Время доставки?
Примерное время сообщит курьер при принятии заказа.

— Способы оплаты?
Наличными курьеру или банковским переводом (комиссия 5%).

— Связь со службой поддержки?
Напишите нам в сообщения сообщества.`;

const TEXT_EMPLOYMENT = `Трудоустройство:

Мы набираем курьеров!

Требования:
— Наличие транспорта (велосипед, самокат, авто, и тп)
— Ответственность и пунктуальность
— Знание района доставки

Для подачи заявки напишите: "Хочу стать курьером"
Или свяжитесь с нами через сообщения сообщества.`;

// ========== УТИЛИТЫ ==========

function getSession(vkId) {
  if (!sessions.has(vkId)) {
    sessions.set(vkId, { state: 'IDLE', data: {} });
  }
  return sessions.get(vkId);
}

function setSession(vkId, state, data = {}) {
  sessions.set(vkId, { state, data });
}

function getCart(vkId) {
  if (!carts.has(vkId)) {
    carts.set(vkId, { items: [] });
  }
  return carts.get(vkId);
}

function clearCart(vkId) {
  carts.set(vkId, { items: [] });
}

function cartTotal(items) {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

function cartTotalCost(items) {
  return items.reduce((sum, i) => sum + i.cost * i.qty, 0);
}

function cartText(items, discount = 0) {
  if (items.length === 0) return 'Корзина пуста.';
  const lines = items.map(i => `${i.name} | ${i.price}р. (х${i.qty})`);
  const total = cartTotal(items);
  const finalTotal = total - discount;
  let text = '____________\n' + lines.join('\n') + '\n______________\n';
  if (discount > 0) {
    text += `Скидка: -${discount}р.\n`;
  }
  text += `Итог: ${finalTotal}р.`;
  return text;
}

function btn(label, payload, color = 'default') {
  return { action: { type: 'callback', label, payload: JSON.stringify(payload) }, color };
}

function textBtn(label, payload, color = 'default') {
  return { action: { type: 'text', label, payload: JSON.stringify(payload) }, color };
}

function makeKeyboard(rows, inline = true) {
  return JSON.stringify({ inline, buttons: rows });
}

// ========== МЕНЮ ==========

function mainMenuKeyboard(hasActiveOrder = false) {
  const rows = [
    [btn('Каталог', { dc: 'catalog' }), btn('Заказать', { dc: 'order' })],
    [btn('Трудоустройство', { dc: 'employment' }), btn('Частые вопросы', { dc: 'faq' })],
  ];
  if (hasActiveOrder) {
    rows.push([btn('Статус заказа', { dc: 'status' }, 'positive')]);
  }
  return makeKeyboard(rows);
}

function mainMenuText() {
  return 'Главное меню\n\nВыберите раздел:';
}

// ========== КАТАЛОГ ==========

function catalogCatsKeyboard() {
  const cats = categoryGetAll();
  const rows = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row = [btn(cats[i].name, { dc: 'cat', id: cats[i].id })];
    if (cats[i + 1]) row.push(btn(cats[i + 1].name, { dc: 'cat', id: cats[i + 1].id }));
    rows.push(row);
  }
  rows.push([btn('Назад', { dc: 'back' }, 'negative')]);
  return makeKeyboard(rows);
}

function catalogItemsKeyboard(categoryId, page = 0) {
  const items = productGetAll(categoryId);
  const perPage = 6;
  const start = page * perPage;
  const pageItems = items.slice(start, start + perPage);
  const rows = [];
  for (let i = 0; i < pageItems.length; i += 2) {
    const row = [btn(pageItems[i].name, { dc: 'product_info', id: pageItems[i].id })];
    if (pageItems[i + 1]) row.push(btn(pageItems[i + 1].name, { dc: 'product_info', id: pageItems[i + 1].id }));
    rows.push(row);
  }
  const navRow = [btn('Назад', { dc: 'back_cats' }, 'negative')];
  if (page > 0) navRow.unshift(btn('Пред.', { dc: 'cat_page', id: categoryId, p: page - 1 }));
  if (start + perPage < items.length) navRow.push(btn('След.', { dc: 'cat_page', id: categoryId, p: page + 1 }));
  rows.push(navRow);
  return makeKeyboard(rows);
}

// ========== КОРЗИНА ==========

function cartKeyboard(discount = 0) {
  return makeKeyboard([
    [btn('Добавить товар', { dc: 'add_item' }), btn('Удалить товар', { dc: 'remove_item' })],
    [btn('Очистить корзину', { dc: 'clear_cart' }, 'negative')],
    [btn('Оформить заказ', { dc: 'checkout' }, 'positive')],
    [btn('Главное меню', { dc: 'main' }, 'secondary')],
  ]);
}

function removeItemKeyboard(items) {
  const rows = items.map(item => [btn(`Удалить: ${item.name} (х${item.qty})`, { dc: 'do_remove', name: item.name })]);
  rows.push([btn('Назад', { dc: 'back_cart' }, 'negative')]);
  return makeKeyboard(rows);
}

// ========== ЗАКАЗ — КАТЕГОРИИ ДЛЯ ДОБАВЛЕНИЯ ТОВАРА ==========

function orderCatsKeyboard() {
  const cats = categoryGetAll();
  const rows = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row = [btn(cats[i].name, { dc: 'order_cat', id: cats[i].id })];
    if (cats[i + 1]) row.push(btn(cats[i + 1].name, { dc: 'order_cat', id: cats[i + 1].id }));
    rows.push(row);
  }
  // Сеты отдельно
  rows.push([btn('Сеты', { dc: 'order_sets' })]);
  rows.push([btn('Назад в корзину', { dc: 'back_cart' }, 'negative')]);
  return makeKeyboard(rows);
}

function orderItemsKeyboard(categoryId, page = 0) {
  const items = productGetAll(categoryId);
  const perPage = 6;
  const start = page * perPage;
  const pageItems = items.slice(start, start + perPage);
  const rows = [];
  for (let i = 0; i < pageItems.length; i += 2) {
    const row = [btn(pageItems[i].name + ' ' + pageItems[i].price + 'р.', { dc: 'add_product', id: pageItems[i].id })];
    if (pageItems[i + 1]) row.push(btn(pageItems[i + 1].name + ' ' + pageItems[i + 1].price + 'р.', { dc: 'add_product', id: pageItems[i + 1].id }));
    rows.push(row);
  }
  const navRow = [btn('Назад', { dc: 'add_item' }, 'negative')];
  if (page > 0) navRow.unshift(btn('Пред.', { dc: 'order_cat_page', id: categoryId, p: page - 1 }));
  if (start + perPage < items.length) navRow.push(btn('След.', { dc: 'order_cat_page', id: categoryId, p: page + 1 }));
  rows.push(navRow);
  return makeKeyboard(rows);
}

function orderSetsKeyboard(page = 0) {
  const sets = setGetAll();
  const perPage = 6;
  const start = page * perPage;
  const pageSets = sets.slice(start, start + perPage);
  const rows = [];
  for (let i = 0; i < pageSets.length; i += 2) {
    const row = [btn(pageSets[i].name + ' ' + pageSets[i].price + 'р.', { dc: 'add_set', id: pageSets[i].id })];
    if (pageSets[i + 1]) row.push(btn(pageSets[i + 1].name + ' ' + pageSets[i + 1].price + 'р.', { dc: 'add_set', id: pageSets[i + 1].id }));
    rows.push(row);
  }
  const navRow = [btn('Назад', { dc: 'add_item' }, 'negative')];
  if (page > 0) navRow.unshift(btn('Пред.', { dc: 'order_sets_page', p: page - 1 }));
  if (start + perPage < sets.length) navRow.push(btn('След.', { dc: 'order_sets_page', p: page + 1 }));
  rows.push(navRow);
  return makeKeyboard(rows);
}

function paymentKeyboard() {
  return makeKeyboard([
    [btn('Наличными', { dc: 'pay_cash' }, 'positive')],
    [btn('Банковский счёт', { dc: 'pay_bank' })],
    [btn('Назад', { dc: 'back_promo' }, 'negative')],
  ]);
}

function confirmKeyboard() {
  return makeKeyboard([
    [btn('Всё верно', { dc: 'confirm_ok' }, 'positive')],
    [btn('Изменить', { dc: 'confirm_edit' }, 'negative')],
  ]);
}

function promoKeyboard() {
  return makeKeyboard([
    [btn('Пропустить', { dc: 'skip_promo' }, 'secondary')],
    [btn('Назад', { dc: 'back_confirm' }, 'negative')],
  ]);
}

function activeOrderKeyboard(orderId) {
  return makeKeyboard([
    [btn('Статус заказа', { dc: 'status' }, 'positive')],
    [btn('Связь с курьером', { dc: 'courier_link', oid: orderId })],
    [btn('Главное меню', { dc: 'main' }, 'secondary')],
  ]);
}

// ========== ГЛАВНЫЙ ОБРАБОТЧИК ==========

/**
 * Обрабатывает входящее событие от клиента ГР2
 * @param {object} vkMsg    — объект message из VK Long Poll
 * @param {function} sendMsg — async (peerId, text, params) => void
 * @param {function} editMsg — async (peerId, cmid, text, params) => void
 * @param {function} sendPhoto — async (peerId, photoUrl, text, params) => number (cmid)
 * @param {function} notifyDispatch — async (order) => void
 * @param {object} botCtx   — { group1: callVK1, group2: callVK2 }
 */
async function handleDeliveryClient(vkMsg, sendMsg, editMsg, sendPhoto, notifyDispatch, botCtx) {
  const userId = vkMsg.from_id;
  const peerId = vkMsg.peer_id;
  const text = (vkMsg.text || '').trim();
  const session = getSession(userId);

  // Если это callback (кнопка) — обрабатываем payload
  if (vkMsg._callbackPayload) {
    const p = vkMsg._callbackPayload;
    return await handleDeliveryCallback(userId, peerId, p, session, sendMsg, editMsg, sendPhoto, notifyDispatch, botCtx, vkMsg);
  }

  // Обработка текстовых состояний (ввод с клавиатуры)
  if (session.state === 'ORDER_NICK') {
    return await handleNickInput(userId, peerId, text, session, sendMsg, editMsg, botCtx);
  }
  if (session.state === 'ORDER_LOCATION') {
    return await handleLocationInput(userId, peerId, text, session, sendMsg, editMsg, botCtx);
  }
  if (session.state === 'ORDER_PROMO') {
    return await handlePromoInput(userId, peerId, text, session, sendMsg, editMsg, botCtx);
  }
  if (session.state === 'ORDER_PAYMENT_PROOF') {
    return await handlePaymentProof(userId, peerId, vkMsg, session, sendMsg, editMsg, notifyDispatch, botCtx);
  }

  // Команда "Начать" или любой текст при IDLE
  if (text.toLowerCase() === 'начать' || session.state === 'IDLE') {
    return await showMainMenu(userId, peerId, sendMsg);
  }

  // По умолчанию — главное меню
  return await showMainMenu(userId, peerId, sendMsg);
}

// ============ CALLBACK HANDLER ============

async function handleDeliveryCallback(userId, peerId, p, session, sendMsg, editMsg, sendPhoto, notifyDispatch, botCtx, vkMsg) {
  const dc = p.dc;
  const cart = getCart(userId);

  switch (dc) {
    // ---- ГЛАВНОЕ МЕНЮ ----
    case 'main':
      return await showMainMenu(userId, peerId, sendMsg, editMsg, vkMsg);

    // ---- КАТАЛОГ ----
    case 'catalog':
      return await showCatalogCats(userId, peerId, editMsg, vkMsg);

    case 'cat':
      return await showCatalogItems(userId, peerId, p.id, 0, editMsg, vkMsg);

    case 'cat_page':
      return await showCatalogItems(userId, peerId, p.id, p.p || 0, editMsg, vkMsg);

    case 'back_cats':
      return await showCatalogCats(userId, peerId, editMsg, vkMsg);

    case 'product_info':
      return await showProductInfo(userId, peerId, p.id, editMsg, sendPhoto, vkMsg);

    // ---- ТРУДОУСТРОЙСТВО / FAQ ----
    case 'employment':
      setSession(userId, 'EMPLOYMENT');
      return await editOrSend(userId, peerId, TEXT_EMPLOYMENT,
        { keyboard: makeKeyboard([[btn('Назад', { dc: 'main' }, 'negative')]]) },
        sendMsg, editMsg, vkMsg);

    case 'faq':
      setSession(userId, 'FAQ');
      return await editOrSend(userId, peerId, TEXT_FAQ,
        { keyboard: makeKeyboard([[btn('Назад', { dc: 'main' }, 'negative')]]) },
        sendMsg, editMsg, vkMsg);

    // ---- ЗАКАЗ — ВХОД ----
    case 'order': {
      clearCart(userId);
      setSession(userId, 'CART', {});
      return await showCart(userId, peerId, editMsg, vkMsg);
    }

    // ---- КОРЗИНА ----
    case 'back_cart':
      setSession(userId, 'CART', session.data);
      return await showCart(userId, peerId, editMsg, vkMsg);

    case 'clear_cart':
      clearCart(userId);
      setSession(userId, 'CART', {});
      return await showCart(userId, peerId, editMsg, vkMsg);

    case 'remove_item':
      if (cart.items.length === 0) {
        return await showCart(userId, peerId, editMsg, vkMsg);
      }
      return await editOrSend(userId, peerId,
        'Выберите товар для удаления:\n' + cartText(cart.items),
        { keyboard: removeItemKeyboard(cart.items) },
        sendMsg, editMsg, vkMsg);

    case 'do_remove': {
      const name = p.name;
      const idx = cart.items.findIndex(i => i.name === name);
      if (idx !== -1) {
        if (cart.items[idx].qty > 1) {
          cart.items[idx].qty -= 1;
        } else {
          cart.items.splice(idx, 1);
        }
      }
      return await showCart(userId, peerId, editMsg, vkMsg);
    }

    // ---- ДОБАВЛЕНИЕ ТОВАРА ----
    case 'add_item':
      return await showOrderCats(userId, peerId, editMsg, vkMsg);

    case 'order_cat':
      return await showOrderItems(userId, peerId, p.id, 0, editMsg, vkMsg);

    case 'order_cat_page':
      return await showOrderItems(userId, peerId, p.id, p.p || 0, editMsg, vkMsg);

    case 'order_sets':
      return await showOrderSets(userId, peerId, 0, editMsg, vkMsg);

    case 'order_sets_page':
      return await showOrderSets(userId, peerId, p.p || 0, editMsg, vkMsg);

    case 'add_product': {
      const prod = productGet(p.id);
      if (!prod) return;
      const existing = cart.items.find(i => i.product_id === prod.id && !i.set_id);
      if (existing) {
        existing.qty += 1;
      } else {
        cart.items.push({ product_id: prod.id, set_id: null, name: prod.name, price: prod.price, cost: prod.cost, qty: 1 });
      }
      return await showCart(userId, peerId, editMsg, vkMsg);
    }

    case 'add_set': {
      const s = setGet(p.id);
      if (!s) return;
      const existing = cart.items.find(i => i.set_id === s.id);
      if (existing) {
        existing.qty += 1;
      } else {
        cart.items.push({ product_id: null, set_id: s.id, name: s.name, price: s.price, cost: s.cost, qty: 1 });
      }
      return await showCart(userId, peerId, editMsg, vkMsg);
    }

    // ---- ОФОРМЛЕНИЕ ----
    case 'checkout': {
      if (cart.items.length === 0) {
        return await showCart(userId, peerId, editMsg, vkMsg);
      }
      setSession(userId, 'ORDER_NICK', { ...session.data });
      return await editOrSend(userId, peerId,
        cartText(cart.items) + '\n\nВведите ваш никнейм:',
        { keyboard: makeKeyboard([[btn('Отмена', { dc: 'back_cart' }, 'negative')]]) },
        sendMsg, editMsg, vkMsg);
    }

    // ---- ПОДТВЕРЖДЕНИЕ ----
    case 'confirm_ok': {
      setSession(userId, 'ORDER_PROMO', session.data);
      return await editOrSend(userId, peerId,
        buildOrderSummary(cart.items, session.data, 0) + '\n\nЕсть промокод? Введите его или нажмите "Пропустить":',
        { keyboard: promoKeyboard() },
        sendMsg, editMsg, vkMsg);
    }
    case 'confirm_edit': {
      setSession(userId, 'ORDER_NICK', session.data);
      return await editOrSend(userId, peerId,
        cartText(cart.items) + '\n\nВведите ваш никнейм:',
        { keyboard: makeKeyboard([[btn('Отмена', { dc: 'back_cart' }, 'negative')]]) },
        sendMsg, editMsg, vkMsg);
    }
    case 'back_confirm': {
      setSession(userId, 'ORDER_PROMO', session.data);
      return await editOrSend(userId, peerId,
        buildOrderSummary(cart.items, session.data, 0) + '\n\nВведите промокод или нажмите "Пропустить":',
        { keyboard: promoKeyboard() },
        sendMsg, editMsg, vkMsg);
    }

    // ---- ПРОМОКОД ----
    case 'skip_promo': {
      setSession(userId, 'ORDER_PAYMENT', session.data);
      return await showPayment(userId, peerId, cart, session.data, 0, editMsg, vkMsg);
    }

    case 'back_promo': {
      setSession(userId, 'ORDER_CONFIRM', session.data);
      const d = session.data;
      return await editOrSend(userId, peerId,
        buildOrderSummary(cart.items, d, 0),
        { keyboard: confirmKeyboard() },
        sendMsg, editMsg, vkMsg);
    }

    // ---- ВЫБОР БЕСПЛАТНОГО ТОВАРА ИЗ КАТЕГОРИИ ----
    case 'promo_free_cat_item': {
      const prod = productGet(p.id);
      if (!prod) return;
      // Добавляем бесплатный товар в корзину
      cart.items.push({ product_id: prod.id, set_id: null, name: prod.name + ' (промокод)', price: 0, cost: prod.cost, qty: 1 });
      const discount = 0;
      setSession(userId, 'ORDER_PAYMENT', { ...session.data, promoDiscount: discount, promoCode: session.data.promoCode });
      return await showPayment(userId, peerId, cart, session.data, 0, editMsg, vkMsg);
    }

    // ---- ОПЛАТА ----
    case 'pay_cash': {
      const d = session.data;
      const discount = d.promoDiscount || 0;
      const total = cartTotal(cart.items) - discount;
      const totalCost = cartTotalCost(cart.items);
      const orderId = await createOrder(userId, cart, d, 'cash', null, total, totalCost);
      setSession(userId, 'ORDER_WAITING', { orderId });
      await notifyDispatch({ orderId, org: 'delivery' });
      return await editOrSend(userId, peerId,
        buildOrderSummary(cart.items, d, discount) + '\n\nОплата наличными курьеру.\n\nОжидайте принятия заказа...',
        { keyboard: makeKeyboard([[btn('Главное меню', { dc: 'main' }, 'secondary')]]) },
        sendMsg, editMsg, vkMsg);
    }

    case 'pay_bank': {
      const d = session.data;
      const discount = d.promoDiscount || 0;
      const rawTotal = cartTotal(cart.items) - discount;
      const commPct = 5;
      const totalWithComm = Math.ceil(rawTotal * (1 + commPct / 100));
      const bankAcc = require('./db.cjs').getSetting('bank_account') || '852006';
      setSession(userId, 'ORDER_PAYMENT_PROOF', { ...d, totalWithComm, rawTotal, discount });
      return await editOrSend(userId, peerId,
        buildOrderSummary(cart.items, d, discount) +
        `\n\nОплата банковским переводом (комиссия ${commPct}%).\nПереведите ${totalWithComm}р. на счёт ${bankAcc}.\n\nПришлите скрин оплаты с /timestamp в чате или временем над HUD:`,
        { keyboard: makeKeyboard([[btn('Отмена', { dc: 'main' }, 'negative')]]) },
        sendMsg, editMsg, vkMsg);
    }

    // ---- СТАТУС ЗАКАЗА ----
    case 'status': {
      const active = orderGetByClient(userId);
      if (!active) {
        return await editOrSend(userId, peerId, 'Нет активных заказов.', { keyboard: makeKeyboard([[btn('Главное меню', { dc: 'main' })]]) }, sendMsg, editMsg, vkMsg);
      }
      const statusText = buildStatusText(active);
      return await editOrSend(userId, peerId, statusText, { keyboard: activeOrderKeyboard(active.id) }, sendMsg, editMsg, vkMsg);
    }

    // ---- ССЫЛКА НА КУРЬЕРА ----
    case 'courier_link': {
      const order = orderGet(p.oid);
      if (!order || !order.courier_vk_id) {
        return await editOrSend(userId, peerId, 'Курьер ещё не назначен.', { keyboard: activeOrderKeyboard(p.oid) }, sendMsg, editMsg, vkMsg);
      }
      // Спрашиваем подтверждение
      return await editOrSend(userId, peerId,
        'Вы уверены, что хотите получить ссылку на сообщения курьера?\nКурьер должен будет одобрить ваш запрос.',
        { keyboard: makeKeyboard([[btn('Да, запросить', { dc: 'courier_link_confirm', oid: p.oid }, 'positive'), btn('Нет', { dc: 'status' }, 'negative')]]) },
        sendMsg, editMsg, vkMsg);
    }

    case 'courier_link_confirm': {
      const order = orderGet(p.oid);
      if (!order || !order.courier_vk_id) return;
      // Уведомляем курьера (через диспетчерский модуль)
      if (botCtx && botCtx.notifyCourierLinkRequest) {
        await botCtx.notifyCourierLinkRequest(order, userId);
      }
      return await editOrSend(userId, peerId,
        'Запрос отправлен курьеру. Ожидайте его одобрения.',
        { keyboard: activeOrderKeyboard(p.oid) },
        sendMsg, editMsg, vkMsg);
    }

    default:
      return await showMainMenu(userId, peerId, sendMsg);
  }
}

// ============ ТЕКСТОВЫЕ СОСТОЯНИЯ ============

async function handleNickInput(userId, peerId, text, session, sendMsg, editMsg, botCtx, vkMsg) {
  const cart = getCart(userId);
  if (!text || text.length < 2) {
    await sendMsg(peerId, 'Введите корректный никнейм (минимум 2 символа).');
    return;
  }
  const newData = { ...session.data, nick: text };
  setSession(userId, 'ORDER_LOCATION', newData);
  await sendMsg(peerId, cartText(cart.items) + '\n\nНикнейм: ' + text + '\n\nВведите адрес/место доставки:');
}

async function handleLocationInput(userId, peerId, text, session, sendMsg, editMsg, botCtx, vkMsg) {
  const cart = getCart(userId);
  if (!text || text.length < 3) {
    await sendMsg(peerId, 'Введите корректное место доставки (минимум 3 символа).');
    return;
  }
  const newData = { ...session.data, location: text };
  setSession(userId, 'ORDER_CONFIRM', newData);
  await sendMsg(peerId,
    buildOrderSummary(cart.items, newData, 0) + '\n\nВсё верно?',
    { keyboard: confirmKeyboard() });
}

async function handlePromoInput(userId, peerId, text, session, sendMsg, editMsg, botCtx, vkMsg) {
  const cart = getCart(userId);
  if (!text) return;
  const code = text.trim().toUpperCase();
  const result = applyPromo(code, 'delivery', { items: cart.items, total: cartTotal(cart.items) });

  if (!result.ok) {
    await sendMsg(peerId, result.msg + '\n\nВведите промокод или нажмите "Пропустить":',
      { keyboard: promoKeyboard() });
    return;
  }

  if (result.freeCategory) {
    // Клиент должен выбрать бесплатный товар из категории
    const items = productGetAll(result.freeCategory);
    if (items.length === 0) {
      await sendMsg(peerId, 'Категория пуста. Пропустим промокод.', { keyboard: promoKeyboard() });
      return;
    }
    const rows = items.map(i => [btn(i.name + ' (бесплатно)', { dc: 'promo_free_cat_item', id: i.id })]);
    rows.push([btn('Назад', { dc: 'back_promo' }, 'negative')]);
    setSession(userId, 'ORDER_PROMO_CATEGORY', { ...session.data, promoCode: code });
    await sendMsg(peerId,
      `Промокод "${code}" даёт бесплатный товар!\nВыберите товар из списка:`,
      { keyboard: makeKeyboard(rows) });
    return;
  }

  const discount = result.discount || 0;
  setSession(userId, 'ORDER_PAYMENT', { ...session.data, promoCode: code, promoDiscount: discount });
  await sendMsg(peerId,
    buildOrderSummary(cart.items, session.data, discount) + `\n\nПромокод "${code}" применён, скидка ${discount}р.`,
    { keyboard: paymentKeyboard() });
}

async function handlePaymentProof(userId, peerId, vkMsg, session, sendMsg, editMsg, notifyDispatch, botCtx) {
  const cart = getCart(userId);
  const d = session.data;
  // Проверяем наличие вложения (фото)
  const hasPhoto = vkMsg.attachments && vkMsg.attachments.some(a => a.type === 'photo');
  if (!hasPhoto) {
    await sendMsg(peerId, 'Пожалуйста, пришлите скрин оплаты фотографией.');
    return;
  }
  const photoAtt = vkMsg.attachments.find(a => a.type === 'photo');
  const photoId = `photo${photoAtt.photo.owner_id}_${photoAtt.photo.id}`;
  const discount = d.promoDiscount || 0;
  const totalCost = cartTotalCost(cart.items);
  const orderId = await createOrder(userId, cart, d, 'bank', photoId, d.rawTotal, totalCost);
  setSession(userId, 'ORDER_WAITING', { orderId });
  await notifyDispatch({ orderId, org: 'delivery' });
  await sendMsg(peerId,
    buildOrderSummary(cart.items, d, discount) + '\n\nСкрин оплаты получен. Ожидайте принятия заказа...',
    { keyboard: makeKeyboard([[btn('Главное меню', { dc: 'main' }, 'secondary')]]) });
}

// ============ ПОКАЗ ЭКРАНОВ ============

async function showMainMenu(userId, peerId, sendMsg, editMsg, vkMsg) {
  setSession(userId, 'MAIN_MENU', {});
  const active = orderGetByClient(userId);
  const msgId = await sendMsg(peerId, mainMenuText(), { keyboard: mainMenuKeyboard(!!active) });
  if (msgId) activeMsg.set(userId, msgId);
}

async function showCatalogCats(userId, peerId, editMsg, vkMsg) {
  setSession(userId, 'CATALOG_CATS', {});
  const cats = categoryGetAll();
  const text = cats.length === 0
    ? 'Каталог временно пуст.'
    : 'Каталог\n\nВыберите категорию:';
  await editOrSend(userId, peerId, text, { keyboard: catalogCatsKeyboard() }, null, editMsg, vkMsg);
}

async function showCatalogItems(userId, peerId, categoryId, page, editMsg, vkMsg) {
  const cat = categoryGet(categoryId);
  if (!cat) return;
  const items = productGetAll(categoryId);
  if (items.length === 0) {
    return await editOrSend(userId, peerId, `Категория "${cat.name}" пуста.`,
      { keyboard: makeKeyboard([[btn('Назад', { dc: 'catalog' }, 'negative')]]) }, null, editMsg, vkMsg);
  }
  const perPage = 6;
  const start = page * perPage;
  const pageItems = items.slice(start, start + perPage);
  const text = `Каталог — ${cat.name}\n\n` + pageItems.map(i => `${i.name} — ${i.price}р.`).join('\n');
  await editOrSend(userId, peerId, text, { keyboard: catalogItemsKeyboard(categoryId, page) }, null, editMsg, vkMsg);
}

async function showProductInfo(userId, peerId, productId, editMsg, sendPhoto, vkMsg) {
  const prod = productGet(productId);
  if (!prod) return;
  const text = `${prod.name}\nЦена: ${prod.price}р.`;
  if (prod.photo_url) {
    await sendPhoto(peerId, prod.photo_url, text, {
      keyboard: makeKeyboard([[btn('Назад', { dc: 'cat', id: prod.category_id }, 'negative')]]),
    });
  } else {
    await editOrSend(userId, peerId, text,
      { keyboard: makeKeyboard([[btn('Назад', { dc: 'cat', id: prod.category_id }, 'negative')]]) },
      null, editMsg, vkMsg);
  }
}

async function showCart(userId, peerId, editMsg, vkMsg) {
  const cart = getCart(userId);
  const discount = getSession(userId).data.promoDiscount || 0;
  const text = 'Корзина:\n____________\n' + cartText(cart.items, discount);
  await editOrSend(userId, peerId, text, { keyboard: cartKeyboard(discount) }, null, editMsg, vkMsg);
}

async function showOrderCats(userId, peerId, editMsg, vkMsg) {
  const cart = getCart(userId);
  setSession(userId, 'CART', getSession(userId).data);
  const text = 'Корзина:\n' + cartText(cart.items) + '\n\nВыберите категорию товара:';
  await editOrSend(userId, peerId, text, { keyboard: orderCatsKeyboard() }, null, editMsg, vkMsg);
}

async function showOrderItems(userId, peerId, categoryId, page, editMsg, vkMsg) {
  const cat = categoryGet(categoryId);
  if (!cat) return;
  const items = productGetAll(categoryId);
  if (items.length === 0) {
    return await editOrSend(userId, peerId, `Категория "${cat.name}" пуста.`,
      { keyboard: makeKeyboard([[btn('Назад', { dc: 'add_item' }, 'negative')]]) }, null, editMsg, vkMsg);
  }
  const cart = getCart(userId);
  const text = 'Корзина:\n' + cartText(cart.items) + `\n\n${cat.name} — выберите товар:`;
  await editOrSend(userId, peerId, text, { keyboard: orderItemsKeyboard(categoryId, page) }, null, editMsg, vkMsg);
}

async function showOrderSets(userId, peerId, page, editMsg, vkMsg) {
  const sets = setGetAll();
  if (sets.length === 0) {
    return await editOrSend(userId, peerId, 'Сеты временно недоступны.',
      { keyboard: makeKeyboard([[btn('Назад', { dc: 'add_item' }, 'negative')]]) }, null, editMsg, vkMsg);
  }
  const cart = getCart(userId);
  const text = 'Корзина:\n' + cartText(cart.items) + '\n\nСеты — выберите:';
  await editOrSend(userId, peerId, text, { keyboard: orderSetsKeyboard(page) }, null, editMsg, vkMsg);
}

async function showPayment(userId, peerId, cart, data, discount, editMsg, vkMsg) {
  const text = buildOrderSummary(cart.items, data, discount) + '\n\nВыберите способ оплаты:';
  await editOrSend(userId, peerId, text, { keyboard: paymentKeyboard() }, null, editMsg, vkMsg);
}

// ============ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ============

function buildOrderSummary(items, data, discount) {
  const lines = items.map(i => `${i.name} | ${i.price}р. (х${i.qty})`);
  const total = cartTotal(items);
  const finalTotal = total - (discount || 0);
  let text = `Никнейм: ${data.nick || '—'}\nМесто: ${data.location || '—'}\n\nЗаказ:\n`;
  text += lines.join('\n') + '\n';
  if (discount > 0) text += `Скидка: -${discount}р.\n`;
  text += `\nИтого: ${finalTotal}р.`;
  return text;
}

function buildStatusText(order) {
  const statuses = {
    pending:    'Ожидает курьера...',
    accepted:   `Курьер: ${order.courier_nick}\nПримерное время: ${order.eta_minutes || '?'} мин.`,
    preparing:  'Заказ собирается',
    delivering: `Курьер едет к вам!\nКурьер: ${order.courier_nick}`,
    arrived:    'Курьер прибыл!',
    done:       'Заказ выполнен. Спасибо!',
    cancelled:  'Заказ отменён.',
  };
  return `Статус заказа #${order.id}:\n${statuses[order.status] || order.status}`;
}

async function createOrder(userId, cart, data, paymentType, paymentProof, total, totalCost) {
  const discount = data.promoDiscount || 0;
  const finalTotal = total - discount;
  const orderId = orderCreate({
    client_vk_id: userId,
    client_nick: data.nick,
    location: data.location,
    payment_type: paymentType,
    promo_code: data.promoCode || null,
    discount_amt: discount,
    total_price: finalTotal,
    total_cost: totalCost,
    cart_msg_id: null,
    org: 'delivery',
  });
  for (const item of cart.items) {
    orderAddItem(orderId, item);
  }
  if (data.promoCode) {
    promoUse(data.promoCode);
  }
  clearCart(userId);
  return orderId;
}

// Редактировать активное сообщение или отправить новое
async function editOrSend(userId, peerId, text, params, sendMsg, editMsg, vkMsg) {
  const cmid = activeMsg.get(userId);
  if (cmid && editMsg) {
    try {
      await editMsg(peerId, cmid, text, params);
      return cmid;
    } catch (e) {
      // Если не получилось отредактировать — отправляем новое
    }
  }
  if (sendMsg) {
    const newCmid = await sendMsg(peerId, text, params);
    if (newCmid) activeMsg.set(userId, newCmid);
    return newCmid;
  }
}

module.exports = {
  handleDeliveryClient,
  getSession,
  setSession,
  activeMsg,
  buildStatusText,
};
