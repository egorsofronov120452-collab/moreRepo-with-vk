# Перенос функций бота в VK Mini App

## Что можно реализовать через Mini App (рекомендуется)

VK Mini App — это React/Vue веб-приложение, которое открывается прямо внутри ВКонтакте.  
Ключевые преимущества для данного проекта:
- Интерактивная карта для выбора точек такси (Leaflet / react-leaflet)
- Красивый каталог с фото, пагинацией и корзиной
- Профиль сотрудника с фото машины
- Статистика онлайна в реальном времени

---

## 1. Создание Mini App

1. Открыть https://vk.com/editapp?act=create
2. Выбрать тип **«Приложение для сообщества»**
3. Привязать к сообществу 2 (Доставка) или создать общее приложение
4. Указать **URL сервера** — ваш деплой на Vercel (например `https://your-app.vercel.app`)
5. В настройках приложения → **«Настройки»** → включить `«Доступ к сообщениям сообщества»`

---

## 2. Технологический стек

```
frontend/
  ├── src/
  │   ├── App.tsx              # роутинг
  │   ├── pages/
  │   │   ├── MainMenu.tsx     # главное меню (доставка / такси)
  │   │   ├── Catalogue.tsx    # каталог с фото
  │   │   ├── Order.tsx        # корзина и оформление заказа
  │   │   ├── TaxiMap.tsx      # карта с выбором точек (Leaflet)
  │   │   ├── Profile.tsx      # профиль сотрудника
  │   │   └── OrderStatus.tsx  # статус активного заказа
  │   └── api/
  │       └── bot.ts           # вызовы к вашему серверу (Express/Next.js API)
  └── package.json
```

Установка SDK:

```bash
npm install @vkontakte/vk-bridge @vkontakte/vkui
npm install react-leaflet leaflet
```

---

## 3. Инициализация VK Bridge

```typescript
// src/main.tsx
import bridge from '@vkontakte/vk-bridge';
bridge.send('VKWebAppInit');

// Получить user_id текущего пользователя
const { id } = await bridge.send('VKWebAppGetUserInfo');
```

---

## 4. Интерактивная карта (такси)

```tsx
// src/pages/TaxiMap.tsx
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';

// Загружаем точки из вашего API (которое читает taxi_points.json)
const points = await fetch('/api/taxi-points').then(r => r.json());

<MapContainer center={[55.75, 37.62]} zoom={13}>
  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
  {points.map(pt => (
    <Marker key={pt.id} position={[pt.lat, pt.lng]}>
      <Popup>{pt.name} — от {pt.defaultPrice}р.</Popup>
    </Marker>
  ))}
</MapContainer>
```

> Важно: точки в `taxi_points.json` хранят координаты `x, y` из редактора карты.  
> При переходе на Mini App заменить `x/y` на реальные `lat/lng` в `map-editor.html`  
> (добавить поля «Широта» и «Долгота» вместо или вместе с X/Y).

---

## 5. Автоматический расчёт стоимости

```typescript
// Обновить calculateTaxiPrice() в long-polling.cjs:
// Вместо евклидовой дистанции использовать Haversine formula

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2-lat1) * Math.PI/180;
  const dLon = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Тариф: 45р/км базово, +30% в пиковые часы (18-22 МСК)
function calculateTaxiPrice(from, to) {
  if (from.lat && to.lat) {
    const km = haversine(from.lat, from.lng, to.lat, to.lng);
    const hour = new Date(...).getHours();
    const peak = (hour >= 18 && hour <= 22) ? 1.3 : 1.0;
    return Math.round(km * 45 * peak);
  }
  return from.defaultPrice || 500;
}
```

---

## 6. API-сервер (Express) для Mini App

Добавьте `scripts/api-server.cjs` — простой Express сервер, который:
- Отдаёт каталог, точки такси, статус заказа по orderId
- Принимает создание заказа (вызывает ту же логику что и бот)
- Авторизует пользователей через `vk_sign` (VK Launch Params)

```javascript
const express = require('express');
const app = express();
app.use(express.json());

app.get('/api/catalogue', (req, res) => {
  res.json(readJSON(CATALOGUE_FILE));
});
app.get('/api/taxi-points', (req, res) => {
  res.json(readJSON(TAXI_POINTS_FILE));
});
app.post('/api/order', async (req, res) => {
  // Validate vk_sign, then create order
  const order = createDeliveryOrder(req.body);
  await sendOrderToDispatch(order);
  res.json({ ok: true, orderId: order.id });
});

app.listen(3001, () => console.log('[API] running on :3001'));
```

---

## 7. Что остаётся в боте (long-polling.cjs)

Следующие части лучше **оставить в боте** (не переносить в Mini App):
- Диспетчерская — приём заказов с inline-кнопками в чате
- Журнал активности (`!онлайн`, `!афк`, `!вышел`)
- Экран закупок курьера (редактирование сообщения)
- Ежедневные/еженедельные отчёты руководству
- Чат-команды (`!кик`, `!бан`, `!пост` и т.д.)

---

## 8. Деплой

```bash
# Vercel (рекомендуется)
vercel --prod

# PM2 для бота + API
pm2 start scripts/long-polling.cjs --name bot
pm2 start scripts/api-server.cjs --name api
pm2 save
```

Vercel автоматически обнаружит `package.json` и задеплоит Next.js / Vite frontend.  
Убедитесь что `scripts/long-polling.cjs` **не** является entry-point для Vercel  
(он запускается отдельно на VPS через PM2).
