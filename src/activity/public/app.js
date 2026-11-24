import { DiscordSDK } from './vendor/discord-sdk.js';

const $ = (selector) => document.querySelector(selector);
const base = location.hostname.endsWith('discordsays.com') ? '/.proxy' : '';

const state = {
  sdk: null,
  token: null,
  guildId: null,
  data: null,
  filter: 'all',
  image: null,
  imageName: null,
  backgroundImage: null,
  backgroundImageName: null,
  characterImage: null,
  characterImageName: null,
  sheet: null,
  demo: false,
  busy: false,
};

const CUSTOM_ID = 'custom';

const TABS = [
  { id: 'all', label: 'الكل' },
  { id: 'xp', label: 'الخبرة' },
  { id: 'behavior', label: 'السلوك' },
  { id: 'title', label: 'الألقاب' },
  { id: 'role', label: 'الرتب' },
  { id: 'emoji', label: 'الإيموجي' },
  { id: 'background', label: 'الخلفيات' },
  { id: 'character', label: 'الشخصيات' },
];

// The server sends rarity as a key; the card and the sheet show this label.
const RARITIES = {
  common: 'عادي',
  rare: 'نادر',
  epic: 'ملحمي',
  legendary: 'أسطوري',
};

function rarityLabel(rarity) {
  return RARITIES[rarity] ?? RARITIES.common;
}

const REASONS = {
  unknown: 'هذا العنصر ما عاد موجود.',
  disabled: 'هذا العنصر مقفّل في هذا السيرفر.',
  unpriced: 'هذا العنصر ما له سعر إلى الآن.',
  limit: 'وصلت الحد الأقصى من هذا العنصر.',
  funds: 'كوينزك ما تكفي.',
  level: 'مستواك ما وصل لهذا بعد.',
  custom: 'ارفع خلفية مخصصة أول.',
  action: 'طلب غير معروف.',
  name: 'تأكد من الاسم اللي كتبته.',
  color: 'هذا اللون مو صحيح.',
  image: 'اختر صورة PNG أو JPEG أو WebP أو GIF.',
  size: 'الصورة كبيرة (الحد 256 كيلوبايت).',
  dimensions: 'أبعاد الصورة صغيرة أو كبيرة زيادة.',
  price: 'السعر لازم يكون رقم صحيح من الكوينز.',
  pending: 'عندك حجز معلّق أصلاً.',
  slots: 'ما فيه أماكن فاضية للإيموجي في السيرفر.',
  permission: 'البوت ما عنده الصلاحية المطلوبة.',
  delivery: 'ديسكورد رفض العملية، ورجّعنا كوينزك.',
  guild: 'البوت مو في هذا السيرفر.',
  member: 'أنت مو عضو في هذا السيرفر.',
  database: 'ما انخصم شي. جرّب مرة ثانية.',
  auth: 'جلستك انتهت. افتح المتجر من جديد.',
  server: 'صار خطأ في المتجر. جرّب مرة ثانية.',
};

/* ── Small helpers ────────────────────────────────────────────────────────── */

function format(value) {
  return new Intl.NumberFormat('en-US').format(Number(value) || 0);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function coinSvg() {
  return `<img class="coin-icon" src="${base}/assets/coin.png" alt="" aria-hidden="true" />`;
}

function glyph(type) {
  const open = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">';
  const shapes = {
    xp: '<path d="M13.2 1.8 4.6 13.1c-.3.4 0 .9.5.9h5.1l-1.3 8.2c-.1.6.6.9 1 .5l8.5-11.3c.3-.4 0-.9-.5-.9h-5.1l1.3-8.2c.1-.6-.6-.9-.9-.5Z"/>',
    behavior:
      '<path d="M12 21s-8.2-4.9-9.8-9.6C1.1 7.7 3.5 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.5 0 5.9 3.2 4.8 6.9C20.2 16.1 12 21 12 21Z"/>',
    title:
      '<path d="m12 2 2.6 6.7 7.2.5-5.5 4.6 1.8 7L12 16.9 5.9 20.8l1.8-7L2.2 9.2l7.2-.5L12 2Z"/>',
    role:
      '<path d="M3 8.2 7.2 11 12 5l4.8 6L21 8.2l-1.9 9.3H4.9L3 8.2Zm3.2 11h11.6v1.4H6.2v-1.4Z"/>',
    emoji:
      '<path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm-3.2 5.3a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Zm6.4 0a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6ZM7.4 14.2h9.2a5 5 0 0 1-9.2 0Z"/>',
    background:
      '<path d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm1 13.2V19h14v-6.5l-3.8 3.4-3.6-3.6-6.6 3.9ZM8 6.2a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Z"/>',
    character:
      '<path d="M12 2.5a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4Zm0 10.2c4.6 0 8.3 2.5 8.3 5.6V21H3.7v-2.7c0-3.1 3.7-5.6 8.3-5.6Z"/>',
  };

  return `${open}${shapes[type] ?? shapes.background}</svg>`;
}

function setBoot(text) {
  $('#boot-text').textContent = text;
}

function showFatal(message) {
  $('#boot').hidden = false;
  $('#app').hidden = true;
  setBoot(message);
  $('#boot-retry').hidden = false;
}

function showApp() {
  $('#boot').hidden = true;
  $('#app').hidden = false;
  // A retry after a failed load can leave the page scrolled mid-way.
  window.scrollTo(0, 0);
}

let toastTimer;

function toast(message, kind = '') {
  const el = $('#toast');

  el.textContent = message;
  el.className = `toast ${kind}`.trim();
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3400);
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};

  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;

  let response;

  try {
    response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('ما وصلنا للمتجر. تأكد من اتصالك.');
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok && !payload.reason) {
    throw new Error(payload.message || `فشل الطلب (${response.status}).`);
  }

  return payload;
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */

async function boot() {
  $('#boot-retry').hidden = true;

  try {
    if (new URLSearchParams(location.search).has('demo')) {
      state.demo = true;
      state.data = demoData();
      showApp();
      render();
      return;
    }

    setBoot('نتصل بديسكورد…');
    const config = await api('/api/config', { auth: false });

    if (!config.enabled) {
      throw new Error('متجر الأكتفتي مو مفعّل لهذا البوت.');
    }

    const sdk = new DiscordSDK(config.client_id);
    await sdk.ready();

    setBoot('نتأكد من حسابك…');
    const { code } = await sdk.commands.authorize({
      client_id: config.client_id,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify', 'guilds'],
    });

    const token = await api('/api/token', {
      method: 'POST',
      auth: false,
      body: { code },
    });

    if (!token.access_token) throw new Error('ديسكورد ما رجّع جلسة.');

    await sdk.commands.authenticate({ access_token: token.access_token });

    state.sdk = sdk;
    state.token = token.access_token;
    state.guildId = sdk.guildId;

    if (!state.guildId) throw new Error('افتح المتجر من داخل سيرفر، مو من الخاص.');

    setBoot('نحمّل المتجر…');
    await loadStore();
    showApp();
  } catch (error) {
    console.error(error);
    showFatal(error?.message || 'ما قدرنا نفتح المتجر.');
  }
}

async function loadStore() {
  const response = await api(`/api/store?guildId=${encodeURIComponent(state.guildId)}`);

  if (!response.ok) throw new Error(response.message || 'ما قدرنا نحمّل المتجر.');

  state.data = response.data;
  render();
}

/* ── Render ───────────────────────────────────────────────────────────────── */

function render() {
  const data = state.data;
  if (!data) return;

  $('#guild-name').textContent = data.guild.name;
  const icon = $('#guild-icon');

  if (data.guild.icon) {
    icon.innerHTML = `<img src="${escapeHtml(data.guild.icon)}" alt="">`;
  } else {
    icon.textContent = (data.guild.name || 'م').slice(0, 1).toUpperCase();
  }

  $('#balance').textContent = format(data.balance);
  $('#avatar').src = data.user.avatar;
  $('#user-name').textContent = data.user.name;
  $('#user-level').textContent = `المستوى ${format(data.level)}`;

  renderTabs();
  renderGrid();
}

function renderTabs() {
  const data = state.data;
  const reserve = data.reserve ?? {};
  const manager = Boolean(data.canManage);
  const counts = {
    all: data.items.filter((item) => item.type !== 'background').length,
    xp: data.items.filter((item) => item.type === 'xp').length,
    behavior: data.items.filter((item) => item.type === 'behavior').length,
    title: data.items.filter((item) => item.type === 'title').length,
    role: data.items.filter((item) => item.type === 'role').length,
    emoji: data.items.filter((item) => item.type === 'emoji').length,
    background: data.backgrounds.length,
    character: manager
      ? (data.characters?.length ?? 0) +
        (reserve.hasPending ? 1 : 0) +
        (reserve.enabled ? 1 : 0) +
        2
      : 0,
  };

  // The Characters tab itself is Manage Server only; members never see it.
  const visible = TABS.filter(
    (tab) =>
      (tab.id !== 'character' || manager) && (tab.id === 'all' || counts[tab.id] > 0),
  );

  if (!visible.some((tab) => tab.id === state.filter)) state.filter = 'all';

  $('#tabs').innerHTML = visible
    .map(
      (tab) =>
        `<button class="tab ${state.filter === tab.id ? 'active' : ''}" data-tab="${tab.id}">${tab.label}</button>`,
    )
    .join('');

  for (const button of document.querySelectorAll('[data-tab]')) {
    button.addEventListener('click', () => {
      state.filter = button.dataset.tab;
      renderTabs();
      renderGrid();
    });
  }
}

function renderGrid() {
  if (state.filter === 'background') {
    renderBackgrounds();
    return;
  }

  if (state.filter === 'character') {
    if (!state.data.canManage) {
      state.filter = 'all';
    } else {
      renderCharacters();
      return;
    }
  }

  const list = state.data.items.filter(
    (item) => item.type !== 'background' && (state.filter === 'all' || item.type === state.filter),
  );
  const grid = $('#grid');
  const empty = $('#empty');

  if (list.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    empty.textContent = 'ما فيه شي للبيع في هذا القسم.';
    return;
  }

  empty.hidden = true;
  grid.innerHTML = list.map(itemCard).join('');
  wireItemCards();
}

function itemMeta(item) {
  if (item.stackable) return 'لكل نقطة';
  if (item.atLimit) return 'وصلت الحد';
  if (item.amount > 1) return `+${format(item.amount)}`;
  if (item.needs.includes('image')) return 'مع رفع صورة';
  return '';
}

function itemCard(item) {
  const badge = item.atLimit
    ? '<span class="badge">الحد</span>'
    : item.ownedCount > 0
      ? `<span class="badge owned">×${format(item.ownedCount)}</span>`
      : '';

  return `<button class="card rarity-${item.rarity}" data-item="${escapeHtml(item.key)}">
    <div class="art">
      ${item.art ? `<img src="${escapeHtml(item.art)}" alt="" loading="lazy" decoding="async">` : glyph(item.type)}
      <span class="rarity">${rarityLabel(item.rarity)}</span>
      ${badge}
    </div>
    <div class="card-body">
      <h3>${escapeHtml(item.name)}</h3>
      <span class="card-meta">${escapeHtml(itemMeta(item))}</span>
      <span class="price">${coinSvg()}<span>${format(item.price)}</span></span>
    </div>
  </button>`;
}

function renderBackgrounds() {
  const list = state.data.backgrounds;
  const grid = $('#grid');
  const empty = $('#empty');

  if (list.length === 0 && !state.data.canManage) {
    grid.innerHTML = '';
    empty.hidden = false;
    empty.textContent = 'ما فيه خلفيات إلى الآن.';
    return;
  }

  empty.hidden = true;
  const addCard = state.data.canManage
    ? `<button class="card add-card" id="add-background">
        <div class="art">${glyph('background')}</div>
        <div class="card-body">
          <h3>إضافة خلفية</h3>
          <span class="card-meta">إدارة السيرفر</span>
          <span class="price free">ارفع الصورة وحدّد السعر</span>
        </div>
      </button>`
    : '';

  grid.innerHTML = addCard + list.map(backgroundCard).join('');
  wireBackgroundCards();
  $('#add-background')?.addEventListener('click', openBackgroundCreator);
}

function backgroundCard(background) {
  let badge;
  let price;
  let meta;

  if (background.custom) {
    badge = background.selected
      ? '<span class="badge equipped">مفعّلة</span>'
      : background.hasImage
        ? '<span class="badge owned">مملوكة</span>'
        : background.unlocked
          ? '<span class="badge">جاهزة</span>'
          : `<span class="badge">المستوى ${format(background.level)}</span>`;
    price = background.selected
      ? '<span class="price free">مفعّلة</span>'
      : background.hasImage || background.unlocked
        ? '<span class="price free">اضغط للإدارة</span>'
        : `<span class="price">المستوى ${format(background.level)}</span>`;
    meta = background.hasImage ? 'خلفيتك' : 'ارفع خلفيتك';
  } else {
    badge = background.selected
      ? '<span class="badge equipped">مفعّلة</span>'
      : background.unlocked
        ? '<span class="badge owned">مملوكة</span>'
        : background.price > 0
          ? ''
          : `<span class="badge">المستوى ${format(background.level)}</span>`;

    price = background.selected
      ? '<span class="price free">مفعّلة</span>'
      : background.unlocked
        ? '<span class="price free">اضغط للتفعيل</span>'
        : background.price > 0
          ? `<span class="price">${coinSvg()}<span>${format(background.price)}</span></span>`
          : `<span class="price">المستوى ${format(background.level)}</span>`;

    meta =
      background.id === 'default'
        ? 'متاحة دائمًا'
        : background.price > 0
          ? 'تصميم من المتجر'
          : `المستوى ${format(background.level)}`;
  }

  return `<button class="card rarity-${background.rarity}" data-bg="${escapeHtml(background.id)}">
    <div class="art">
      ${background.art ? `<img src="${escapeHtml(background.art)}" alt="" loading="lazy" decoding="async">` : glyph('background')}
      <span class="rarity">${background.price > 0 ? 'تصميم من المتجر' : rarityLabel(background.rarity)}</span>
      ${badge}
    </div>
    <div class="card-body">
      <h3>${escapeHtml(background.name)}</h3>
      <span class="card-meta">${escapeHtml(meta)}</span>
      ${price}
    </div>
  </button>`;
}

function wireItemCards() {
  for (const card of document.querySelectorAll('[data-item]')) {
    card.addEventListener('click', () => {
      const item = state.data.items.find((entry) => entry.key === card.dataset.item);
      if (item) openItemSheet(item);
    });
  }
}

/* ── Characters ───────────────────────────────────────────────────────────── */

function characterCard(character) {
  const badge = character.owned
    ? '<span class="badge owned">مملوكة</span>'
    : character.price === 0
      ? '<span class="badge">مجانية</span>'
      : '';
  const price = character.owned
    ? '<span class="price free">مملوكة</span>'
    : character.price > 0
      ? `<span class="price">${coinSvg()}<span>${format(character.price)}</span></span>`
      : '<span class="price free">مجانية</span>';

  return `<button class="card character-card rarity-${character.rarity}" data-character="${escapeHtml(character.id)}">
    <div class="art portrait">
      ${character.art ? `<img src="${escapeHtml(character.art)}" alt="" loading="lazy" decoding="async">` : glyph('character')}
      <span class="rarity">شخصية</span>
      ${badge}
    </div>
    <div class="card-body">
      <h3>${escapeHtml(character.name)}</h3>
      <span class="card-meta">للجمع</span>
      ${price}
    </div>
  </button>`;
}

function addCharacterCard() {
  return `<button class="card add-card" id="add-character">
    <div class="art portrait">${glyph('character')}</div>
    <div class="card-body">
      <h3>إضافة شخصية</h3>
      <span class="card-meta">إدارة السيرفر</span>
      <span class="price free">الصورة والسعر</span>
    </div>
  </button>`;
}

function reserveSettingsCard(reserve) {
  return `<button class="card add-card" id="reserve-settings">
    <div class="art portrait">${glyph('character')}</div>
    <div class="card-body">
      <h3>إعدادات الحجز</h3>
      <span class="card-meta">إدارة السيرفر · ${reserve.enabled ? 'ظاهر' : 'مخفي'}</span>
      <span class="price free">${reserve.price > 0 ? `${format(reserve.price)} كوينز` : 'مجاني'}</span>
    </div>
  </button>`;
}

function reservationsCard(count) {
  return `<button class="card add-card" id="character-reservations">
    <div class="art portrait">${glyph('character')}</div>
    <div class="card-body">
      <h3>الحجوزات</h3>
      <span class="card-meta">إدارة السيرفر</span>
      <span class="price free">${format(count)} معلّق</span>
    </div>
  </button>`;
}

function myReservationCard(reservation) {
  return `<button class="card character-card rarity-epic" id="character-my-reservation">
    <div class="art portrait">${glyph('character')}
      <span class="rarity">حجز</span>
      <span class="badge equipped">معلّق</span>
    </div>
    <div class="card-body">
      <h3>${escapeHtml(reservation.name)}</h3>
      <span class="card-meta">حجزك</span>
      <span class="price free">اضغط لتغيير الاسم</span>
    </div>
  </button>`;
}

function reserveCard(price) {
  return `<button class="card character-card rarity-rare" id="character-reserve">
    <div class="art portrait">${glyph('character')}
      <span class="rarity">حجز</span>
    </div>
    <div class="card-body">
      <h3>احجز شخصيتك</h3>
      <span class="card-meta">اختر اسم</span>
      <span class="price ${price > 0 ? '' : 'free'}">${price > 0 ? `${coinSvg()}<span>${format(price)}</span>` : 'مجاني'}</span>
    </div>
  </button>`;
}

function renderCharacters() {
  const data = state.data;
  const reserve = data.reserve ?? {};
  const list = data.characters ?? [];
  const grid = $('#grid');
  const empty = $('#empty');
  const cards = [];

  if (data.canManage) {
    cards.push(addCharacterCard(), reserveSettingsCard(reserve));
    if (reserve.pendingCount > 0) cards.push(reservationsCard(reserve.pendingCount));
  }

  if (reserve.hasPending) cards.push(myReservationCard(reserve.reservation));
  else if (reserve.enabled) cards.push(reserveCard(reserve.price));

  cards.push(...list.map(characterCard));

  if (cards.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    empty.textContent = 'ما فيه شخصيات إلى الآن.';
    return;
  }

  empty.hidden = true;
  grid.innerHTML = cards.join('');

  for (const card of document.querySelectorAll('[data-character]')) {
    card.addEventListener('click', () => {
      const character = state.data.characters.find((entry) => entry.id === card.dataset.character);
      if (character) openCharacterSheet(character);
    });
  }

  $('#add-character')?.addEventListener('click', openCharacterCreator);
  $('#reserve-settings')?.addEventListener('click', openReserveSettings);
  $('#character-reservations')?.addEventListener('click', openReservationsSheet);
  $('#character-reserve')?.addEventListener('click', openReserveSheet);
  $('#character-my-reservation')?.addEventListener('click', openReserveSheet);
}

function wireBackgroundCards() {
  for (const card of document.querySelectorAll('[data-bg]')) {
    card.addEventListener('click', () => {
      const background = state.data.backgrounds.find((entry) => entry.id === card.dataset.bg);
      if (background) openBackgroundSheet(background);
    });
  }
}

/* ── Sheet ────────────────────────────────────────────────────────────────── */

const sheetEls = {
  root: $('#sheet'),
  art: $('#sheet-art'),
  rarity: $('#sheet-rarity'),
  title: $('#sheet-title'),
  summary: $('#sheet-summary'),
  controls: $('#sheet-controls'),
  admin: $('#sheet-admin'),
  action: $('#sheet-action'),
  note: $('#sheet-note'),
};

function openSheet(item, kind) {
  state.sheet = { item, kind };
  state.image = null;
  state.imageName = null;
  state.backgroundImage = null;
  state.backgroundImageName = null;
  state.characterImage = null;
  state.characterImageName = null;
  sheetEls.note.textContent = '';
  sheetEls.note.className = 'sheet-note';
  sheetEls.art.classList.toggle('portrait', kind === 'character');
  sheetEls.art.style.setProperty('--rarity', `var(--${item.rarity ?? 'common'})`);
  sheetEls.art.innerHTML = item.art ? `<img src="${escapeHtml(item.art)}" alt="">` : glyph(item.type ?? 'background');
  sheetEls.rarity.textContent = rarityLabel(item.rarity);
  sheetEls.rarity.style.color = `var(--${item.rarity ?? 'common'})`;
  sheetEls.title.textContent = item.name;
  sheetEls.summary.textContent = item.summary ?? '';
  sheetEls.controls.innerHTML = '';
  sheetEls.admin.innerHTML = '';
  sheetEls.root.hidden = false;
}

function closeSheet() {
  sheetEls.root.hidden = true;
  state.sheet = null;
  state.image = null;
  state.imageName = null;
  state.backgroundImage = null;
  state.backgroundImageName = null;
  state.characterImage = null;
  state.characterImageName = null;
  state.busy = false;
}

function setNote(text, kind = '') {
  sheetEls.note.textContent = text;
  sheetEls.note.className = `sheet-note ${kind}`.trim();
}

function setAction(label, { disabled = false, secondary = false, onClick } = {}) {
  const button = sheetEls.action;

  button.textContent = label;
  button.disabled = disabled;
  button.className = `primary${secondary ? ' secondary' : ''}`;
  button.onclick = onClick ? () => onClick() : null;
}

function balanceNote(total) {
  const balance = state.data.balance;

  if (total <= balance) {
    setNote(`رصيدك: ${format(balance)} كوينز`);
    return false;
  }

  setNote(`تحتاج ${format(total - balance)} كوينز زيادة.`, 'error');
  return true;
}

/* ── Item sheet ───────────────────────────────────────────────────────────── */

function openItemSheet(item) {
  openSheet(item, 'item');

  let quantity = 1;
  let total = item.price;

  const refresh = () => {
    total = item.price * quantity;
    const short = balanceNote(total);
    const label = quantity > 1 ? `شراء ${quantity} · ${format(total)} كوينز` : `شراء · ${format(total)} كوينز`;

    setAction(label, {
      disabled: state.busy || item.atLimit || short,
      onClick: () => buyItem(item, gather(item)),
    });
  };

  const gather = (entry) => {
    const values = { quantity };

    if (entry.type === 'title') values.name = $('#title-input')?.value?.trim() || '';
    if (entry.type === 'role') {
      values.name = $('#role-name')?.value?.trim() || '';
      values.color = $('#role-color-text')?.value?.trim() || '';
    }
    if (entry.type === 'emoji') values.name = $('#emoji-name')?.value?.trim() || '';

    return values;
  };

  if (item.stackable) {
    sheetEls.controls.innerHTML = `<div class="stepper">
      <button type="button" data-step="-1" aria-label="أقل">−</button>
      <div class="stepper-value"><strong id="qty">1</strong><small>كل وحدة ${format(item.price)}</small></div>
      <button type="button" data-step="1" aria-label="أكثر">+</button>
    </div>`;

    const qtyEl = $('#qty');

    for (const button of sheetEls.controls.querySelectorAll('[data-step]')) {
      button.addEventListener('click', () => {
        const next = quantity + Number(button.dataset.step);
        quantity = Math.max(1, Math.min(state.data.maxStack, next));
        qtyEl.textContent = String(quantity);
        refresh();
      });
    }
  }

  if (item.type === 'title') {
    sheetEls.controls.insertAdjacentHTML(
      'beforeend',
      `<div class="field"><label for="title-input">العنوان</label>
        <input id="title-input" type="text" maxlength="32" placeholder="حارس البرج" autocomplete="off"></div>`,
    );
    $('#title-input').addEventListener('input', refresh);
  }

  if (item.type === 'role') {
    sheetEls.controls.insertAdjacentHTML(
      'beforeend',
      `<div class="field"><label for="role-name">اسم الرتبة</label>
        <input id="role-name" type="text" maxlength="32" placeholder="الغروب" autocomplete="off"></div>
      <div class="field"><label for="role-color">اللون</label>
        <div class="color-row">
          <input id="role-color" type="color" value="#ff8800" aria-label="اختر لون">
          <input id="role-color-text" type="text" maxlength="32" value="#ff8800" autocomplete="off">
        </div></div>`,
    );

    const picker = $('#role-color');
    const text = $('#role-color-text');

    picker.addEventListener('input', () => {
      text.value = picker.value;
      refresh();
    });
    text.addEventListener('input', () => {
      if (/^#[0-9a-f]{6}$/i.test(text.value.trim())) picker.value = text.value.trim();
      refresh();
    });
    $('#role-name').addEventListener('input', refresh);
  }

  if (item.type === 'emoji') {
    sheetEls.controls.insertAdjacentHTML(
      'beforeend',
      `<div class="field"><label for="emoji-name">اسم الإيموجي</label>
        <input id="emoji-name" type="text" maxlength="32" placeholder="tower_star" autocomplete="off"></div>
      <div class="field"><label for="emoji-file">الصورة</label>
        <input id="emoji-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
        <span id="image-note" class="card-meta">PNG أو JPEG أو WebP أو GIF · الحد 256 كيلوبايت</span></div>`,
    );

    $('#emoji-name').addEventListener('input', refresh);
    $('#emoji-file').addEventListener('change', (event) => readImage(event.target.files?.[0]));
  }

  refresh();
}

async function readImage(file) {
  if (!file) return;

  const note = $('#image-note');

  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
    note.textContent = 'هذا النوع من الملفات مو مدعوم.';
    state.image = null;
    return;
  }

  if (file.size > 256 * 1024) {
    note.textContent = `حجم الملف ${Math.ceil(file.size / 1024)} كيلوبايت، والحد 256 كيلوبايت.`;
    state.image = null;
    return;
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('تعذّر قراءة الصورة.'));
    reader.readAsDataURL(file);
  }).catch(() => null);

  if (!dataUrl) {
    note.textContent = 'تعذّر قراءة الصورة.';
    return;
  }

  state.image = dataUrl;
  state.imageName = file.name;
  note.textContent = `${file.name} · ${Math.ceil(file.size / 1024)} كيلوبايت`;
  setNote('الصورة جاهزة.');
  toast('الصورة جاهزة.', 'good');
}

async function buyItem(item, values) {
  if (state.demo) {
    toast('وضع العرض — افتح المتجر من ديسكورد تشتري.', 'error');
    return;
  }

  if (state.busy) return;
  state.busy = true;
  setAction('ننفّذ…', { disabled: true });

  try {
    const body = {
      guildId: state.guildId,
      key: item.key,
      quantity: values.quantity ?? 1,
      name: values.name ?? null,
      color: values.color ?? null,
    };

    if (state.image) {
      body.image = state.image;
      body.imageName = state.imageName;
    }

    const result = await api('/api/buy', { method: 'POST', body });

    if (!result.ok) {
      setNote(result.message || REASONS[result.reason] || 'ما تمت عملية الشراء.', 'error');
      state.busy = false;
      return;
    }

    state.data.balance = result.balance ?? state.data.balance;
    closeSheet();
    toast('تم الشراء.', 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
  }
}

/* ── Background sheet ─────────────────────────────────────────────────────── */

function openBackgroundSheet(background) {
  if (background.custom) {
    openCustomBackgroundSheet(background);
    return;
  }

  openSheet(
    {
      ...background,
      type: 'background',
      summary:
        background.price > 0
          ? `تصميم من المتجر. اشتره مرة وحدة واستخدمه بأي مستوى.`
          : background.id === 'default'
            ? 'البطاقة الكلاسيكية، متاحة دائمًا.'
            : `تنفتح عند المستوى ${background.level}.`,
    },
    'background',
  );

  if (background.selected) {
    setAction('مفعّلة الآن', { disabled: true, secondary: true });
  } else if (background.unlocked) {
    setAction('تفعيل', { onClick: () => equipBackground(background) });
  } else if (background.price > 0) {
    const short = balanceNote(background.price);

    setAction(`شراء · ${format(background.price)} كوينز`, {
      disabled: short,
      onClick: () => buyBackground(background),
    });
  } else {
    setAction(`تنفتح عند المستوى ${format(background.level)}`, { disabled: true, secondary: true });
  }

  if (state.data.canManage && background.id !== 'default') {
    addBackgroundAdminControls(background);
  }
}

function openCustomBackgroundSheet(background) {
  const level = format(background.level);

  openSheet(
    {
      ...background,
      type: 'background',
      summary: background.hasImage
        ? `خلفيتك المرفوعة ${background.selected ? 'على بطاقتك.' : 'جاهزة للتفعيل.'} تقدر تبدّلها من هنا.`
        : background.canUpload
          ? `ارفع صورة PNG أو JPEG أو WebP أو GIF (الحد 10 ميجابايت). الخلفيات المخصصة تنفتح عند المستوى ${level}.`
          : `الخلفيات المخصصة تنفتح عند المستوى ${level}. تقدر ترفع وحدة لما توصل له.`,
    },
    'background',
  );

  if (background.canUpload || background.hasImage) {
    sheetEls.controls.innerHTML = `<div class="field">
      <label for="custom-image">${background.hasImage ? 'تبديل الصورة' : 'صورة الخلفية'}</label>
      <input id="custom-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
      <span id="custom-image-note" class="card-meta">PNG أو JPEG أو WebP أو GIF · الحد 10 ميجابايت${background.hasImage ? ' · الصور المتحركة تبقى متحركة' : ''}</span>
    </div>`;

    $('#custom-image').addEventListener('change', (event) => {
      readBackgroundImageFile(event.target.files?.[0], '#custom-image-note').then(refresh);
    });
  }

  function refresh() {
    if (state.backgroundImage) {
      setAction(background.hasImage ? 'تبديل الخلفية' : 'رفع الخلفية', {
        disabled: state.busy,
        onClick: uploadCustomBackground,
      });
      return;
    }

    if (background.selected) {
      setAction('مفعّلة الآن', { disabled: true, secondary: true });
      return;
    }

    if (background.hasImage) {
      setAction('تفعيل', { onClick: () => equipBackground(background) });
      return;
    }

    if (background.canUpload) {
      setAction('اختر صورة أول', { disabled: true, secondary: true });
      return;
    }

    setAction(`تنفتح عند المستوى ${level}`, { disabled: true, secondary: true });
  }

  refresh();
}

async function readBackgroundImageFile(file, noteSelector) {
  const note = $(noteSelector);

  if (!file) return null;

  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
    if (note) note.textContent = 'هذا النوع من الملفات مو مدعوم.';
    state.backgroundImage = null;
    return null;
  }

  if (file.size > 10 * 1024 * 1024) {
    if (note) note.textContent = `حجم الملف ${Math.ceil(file.size / 1024 / 1024)} ميجابايت، والحد 10 ميجابايت.`;
    state.backgroundImage = null;
    return null;
  }

  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });

  if (!dataUrl) {
    if (note) note.textContent = 'تعذّر قراءة الصورة.';
    return null;
  }

  state.backgroundImage = dataUrl;
  state.backgroundImageName = file.name;
  if (note) note.textContent = `${file.name} · ${Math.ceil(file.size / 1024)} كيلوبايت`;
  sheetEls.art.innerHTML = `<img src="${escapeHtml(dataUrl)}" alt="">`;
  setNote('الصورة جاهزة.');

  return dataUrl;
}

async function uploadCustomBackground() {
  if (state.demo) {
    toast('وضع العرض — افتح المتجر من ديسكورد للتغيير.', 'error');
    return;
  }

  if (!state.backgroundImage) {
    setNote('اختر صورة أول.', 'error');
    return;
  }

  if (state.busy) return;

  state.busy = true;
  setAction('نرفع…', { disabled: true });

  try {
    const result = await api('/api/background/custom', {
      method: 'POST',
      body: {
        guildId: state.guildId,
        image: state.backgroundImage,
        imageName: state.backgroundImageName,
      },
    });

    if (!result.ok) {
      setNote(result.message || REASONS[result.reason] || 'ما انحفظت الخلفية.', 'error');
      state.busy = false;
      return;
    }

    closeSheet();
    toast(
      result.animated
        ? `انحفظت الخلفية المخصصة (${format(result.frames)} إطار).`
        : 'انحفظت الخلفية المخصصة.',
      'good',
    );
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
  }
}

function addBackgroundAdminControls(background) {
  sheetEls.admin.innerHTML = `<button type="button" data-edit>تعديل</button>
    <button type="button" class="danger" data-delete>حذف</button>`;

  sheetEls.admin.querySelector('[data-edit]').addEventListener('click', () => {
    openBackgroundEditor(background);
  });

  wireDeleteBackground(background, sheetEls.admin.querySelector('[data-delete]'));
}

function wireDeleteBackground(background, button) {
  if (!button) return;

  let armed = false;

  button.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      button.textContent = 'اضغط مرة ثانية للحذف';
      setNote('هذا يشيل التصميم للجميع. اضغط مرة ثانية للتأكيد.', 'error');
      return;
    }

    deleteBackgroundAdmin(background, button);
  });
}

function openBackgroundCreator() {
  openSheet(
    {
      id: 'new',
      type: 'background',
      name: 'إضافة خلفية',
      rarity: 'rare',
      art: null,
      summary: 'ارفع صورة وحدّد سعر. تظهر في تبويب الخلفيات مباشرة.',
    },
    'background',
  );

  sheetEls.rarity.textContent = 'إدارة السيرفر';
  sheetEls.rarity.style.color = 'var(--gold)';

  sheetEls.controls.innerHTML = `<div class="field">
      <label for="bg-name">الاسم</label>
      <input id="bg-name" type="text" maxlength="40" placeholder="حديقة النيون" autocomplete="off">
    </div>
    <div class="field">
      <label for="bg-price">السعر (كوينز)</label>
      <input id="bg-price" type="number" min="0" max="100000" value="100">
    </div>
    <div class="field">
      <label for="bg-level">المستوى (للتصميم المجاني)</label>
      <input id="bg-level" type="number" min="1" max="999" value="1">
    </div>
    <div class="field">
      <label for="bg-image">الصورة</label>
      <input id="bg-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
      <span id="bg-image-note" class="card-meta">PNG أو JPEG أو WebP أو GIF · الحد 10 ميجابايت</span>
    </div>`;

  const nameInput = $('#bg-name');
  const priceInput = $('#bg-price');

  const refresh = () => {
    const ready = nameInput.value.trim().length > 0 && Boolean(state.backgroundImage);

    setAction('إضافة خلفية', {
      disabled: state.busy || !ready,
      onClick: () => saveBackgroundAdmin({ action: 'create' }),
    });

    if (state.backgroundImage) {
      setNote(`السعر: ${format(Number(priceInput.value) || 0)} كوينز`);
    }
  };

  nameInput.addEventListener('input', refresh);
  priceInput.addEventListener('input', refresh);
  $('#bg-image').addEventListener('change', (event) => {
    readBackgroundImageFile(event.target.files?.[0], '#bg-image-note').then(refresh);
  });

  refresh();
}

function openBackgroundEditor(background) {
  openSheet(
    {
      ...background,
      type: 'background',
      summary:
        'غيّر الاسم أو السعر أو الصورة. الاسم والصورة للجميع، والسعر محفوظ لهذا السيرفر.',
    },
    'background',
  );

  sheetEls.rarity.textContent = 'إدارة السيرفر';
  sheetEls.rarity.style.color = 'var(--gold)';

  sheetEls.controls.innerHTML = `<div class="field">
      <label for="bg-name">الاسم</label>
      <input id="bg-name" type="text" maxlength="40" value="${escapeHtml(background.name)}" autocomplete="off">
    </div>
    <div class="field">
      <label for="bg-price">السعر (كوينز)</label>
      <input id="bg-price" type="number" min="0" max="100000" value="${Number(background.price) || 0}">
    </div>
    <div class="field">
      <label for="bg-level">المستوى (للتصميم المجاني)</label>
      <input id="bg-level" type="number" min="1" max="999" value="${Number(background.level) || 1}">
    </div>
    <div class="field">
      <label for="bg-image">تبديل الصورة (اختياري)</label>
      <input id="bg-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
      <span id="bg-image-note" class="card-meta">PNG أو JPEG أو WebP أو GIF · الحد 10 ميجابايت</span>
    </div>`;

  const nameInput = $('#bg-name');
  const refresh = () => {
    setAction('حفظ التغييرات', {
      disabled: state.busy || nameInput.value.trim().length === 0,
      onClick: () => saveBackgroundAdmin({ action: 'update', id: background.id }),
    });
  };

  nameInput.addEventListener('input', refresh);
  $('#bg-image').addEventListener('change', (event) => {
    readBackgroundImageFile(event.target.files?.[0], '#bg-image-note').then(refresh);
  });

  sheetEls.admin.innerHTML = '<button type="button" class="danger" data-delete>حذف الخلفية</button>';
  wireDeleteBackground(background, sheetEls.admin.querySelector('[data-delete]'));

  refresh();
}

async function saveBackgroundAdmin({ action, id = null }) {
  if (state.demo) {
    toast('وضع العرض — افتح المتجر من ديسكورد لتعديل المتجر.', 'error');
    return;
  }

  if (state.busy) return;

  const name = $('#bg-name')?.value?.trim() || '';
  const price = Number($('#bg-price')?.value);
  const level = Number($('#bg-level')?.value);

  if (!name) {
    setNote('عط الخلفية اسم.', 'error');
    return;
  }

  if (!Number.isInteger(price) || price < 0) {
    setNote('السعر لازم يكون رقم صحيح من الكوينز.', 'error');
    return;
  }

  if (!Number.isInteger(level) || level < 1) {
    setNote('المستوى لازم يكون رقم صحيح من 1 إلى 999.', 'error');
    return;
  }

  if (action === 'create' && !state.backgroundImage) {
    setNote('اختر صورة للخلفية.', 'error');
    return;
  }

  state.busy = true;
  setAction(action === 'create' ? 'نضيف…' : 'نحفظ…', { disabled: true });

  try {
    const body = {
      guildId: state.guildId,
      action,
      id,
      name,
      price,
      level,
    };

    if (state.backgroundImage) {
      body.image = state.backgroundImage;
      body.imageName = state.backgroundImageName;
    }

    const result = await api('/api/admin/background', { method: 'POST', body });

    if (!result.ok) {
      setNote(result.message || REASONS[result.reason] || 'ما انحفظت الخلفية.', 'error');
      state.busy = false;
      return;
    }

    closeSheet();
    toast(action === 'create' ? 'انضافت الخلفية.' : 'تحدّثت الخلفية.', 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
  }
}

async function deleteBackgroundAdmin(background, button) {
  if (state.demo) {
    toast('وضع العرض — افتح المتجر من ديسكورد لتعديل المتجر.', 'error');
    return;
  }

  if (state.busy) return;

  state.busy = true;
  button.disabled = true;
  button.textContent = 'نحذف…';

  try {
    const result = await api('/api/admin/background', {
      method: 'POST',
      body: { guildId: state.guildId, action: 'delete', id: background.id },
    });

    if (!result.ok) {
      setNote(result.message || 'ما انحذفت الخلفية.', 'error');
      state.busy = false;
      button.disabled = false;
      button.textContent = 'اضغط مرة ثانية للحذف';
      return;
    }

    closeSheet();
    toast('انحذفت الخلفية.', 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
    button.disabled = false;
  }
}

async function equipBackground(background) {
  if (state.demo) {
    toast('وضع العرض — افتح المتجر من ديسكورد للتفعيل.', 'error');
    return;
  }

  try {
    const result = await api('/api/equip', {
      method: 'POST',
      body: { guildId: state.guildId, backgroundId: background.id },
    });

    if (!result.ok) {
      setNote(result.message || 'ما قدرنا نفعّل هذي الخلفية.', 'error');
      return;
    }

    closeSheet();
    toast(`${background.name} صارت على بطاقتك.`, 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
  }
}

async function buyBackground(background) {
  if (state.demo) {
    toast('وضع العرض — افتح المتجر من ديسكورد للشراء.', 'error');
    return;
  }

  const item = state.data.items.find((entry) => entry.backgroundId === background.id);

  if (!item) {
    setNote('هذا التصميم مو معروض للبيع حاليًا.', 'error');
    return;
  }

  await buyItem(item, { quantity: 1 });

  // Buying a design should also put it on the card.
  const fresh = state.data.backgrounds.find((entry) => entry.id === background.id);

  if (fresh?.unlocked && !fresh.selected) await equipBackground(fresh);
}

/* ── Character sheets ─────────────────────────────────────────────────────── */

function openCharacterSheet(character) {
  openSheet(
    {
      ...character,
      type: 'character',
      summary: character.owned
        ? 'هذي الشخصية في مجموعتك.'
        : character.price > 0
          ? 'اشتر هذي الشخصية مرة وحدة وخلها في مجموعتك. الشخصيات ما تحتاج مستوى.'
          : 'هذي الشخصية مجانية، خذها.',
    },
    'character',
  );

  if (character.owned) {
    setAction('مملوكة', { disabled: true, secondary: true });
  } else if (character.price > 0) {
    const short = balanceNote(character.price);

    setAction(`شراء · ${format(character.price)} كوينز`, {
      disabled: short,
      onClick: () => buyCharacter(character),
    });
  } else {
    setAction('خذها مجانًا', { onClick: () => buyCharacter(character) });
  }

  if (state.data.canManage) addCharacterAdminControls(character);
}

async function buyCharacter(character) {
  if (state.demo) {
    toast('وضع العرض — افتح المتجر من ديسكورد للشراء.', 'error');
    return;
  }

  if (state.busy) return;
  state.busy = true;
  setAction('ننفّذ…', { disabled: true });

  try {
    const result = await api('/api/character/buy', {
      method: 'POST',
      body: { guildId: state.guildId, characterId: character.id },
    });

    if (!result.ok) {
      setNote(result.message || REASONS[result.reason] || 'ما تمت العملية.', 'error');
      state.busy = false;
      return;
    }

    state.data.balance = result.balance ?? state.data.balance;
    closeSheet();
    toast(`${character.name} انضافت لمجموعتك.`, 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
  }
}

function addCharacterAdminControls(character) {
  sheetEls.admin.innerHTML = `<button type="button" data-edit>تعديل</button>
    <button type="button" class="danger" data-delete>حذف</button>`;

  sheetEls.admin.querySelector('[data-edit]').addEventListener('click', () => {
    openCharacterEditor(character);
  });

  wireDeleteCharacter(character, sheetEls.admin.querySelector('[data-delete]'));
}

function wireDeleteCharacter(character, button) {
  if (!button) return;

  let armed = false;

  button.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      button.textContent = 'اضغط مرة ثانية للحذف';
      setNote('هذا يشيل الشخصية للجميع. اضغط مرة ثانية للتأكيد.', 'error');
      return;
    }

    deleteCharacterAdmin(character, button);
  });
}

function openCharacterCreator() {
  openSheet(
    {
      id: 'new',
      type: 'character',
      name: 'إضافة شخصية',
      rarity: 'rare',
      art: null,
      summary: 'ارفع صورة الشخصية (الأفضل 225 × 350، وأي مقاس ثاني ينقص للحد) وحدّد سعرها بالكوينز.',
    },
    'character',
  );

  sheetEls.rarity.textContent = 'إدارة السيرفر';
  sheetEls.rarity.style.color = 'var(--gold)';

  sheetEls.controls.innerHTML = `<div class="field">
      <label for="character-name">الاسم</label>
      <input id="character-name" type="text" maxlength="40" placeholder="المراقب" autocomplete="off">
    </div>
    <div class="field">
      <label for="character-price">السعر (كوينز)</label>
      <input id="character-price" type="number" min="0" max="100000" value="100">
    </div>
    <div class="field">
      <label for="character-image">الصورة</label>
      <input id="character-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
      <span id="character-image-note" class="card-meta">PNG أو JPEG أو WebP أو GIF · الحد 10 ميجابايت · الأفضل 225 × 350</span>
    </div>`;

  const nameInput = $('#character-name');
  const priceInput = $('#character-price');

  const refresh = () => {
    const ready = nameInput.value.trim().length > 0 && Boolean(state.characterImage);

    setAction('إضافة شخصية', {
      disabled: state.busy || !ready,
      onClick: () => saveCharacterAdmin({ action: 'create' }),
    });

    if (state.characterImage) {
      setNote(`السعر: ${format(Number(priceInput.value) || 0)} كوينز`);
    }
  };

  nameInput.addEventListener('input', refresh);
  priceInput.addEventListener('input', refresh);
  $('#character-image').addEventListener('change', (event) => {
    readCharacterImageFile(event.target.files?.[0], '#character-image-note').then(refresh);
  });

  refresh();
}

function openCharacterEditor(character) {
  openSheet(
    {
      ...character,
      type: 'character',
      summary: 'غيّر الاسم أو السعر أو صورة الشخصية.',
    },
    'character',
  );

  sheetEls.rarity.textContent = 'إدارة السيرفر';
  sheetEls.rarity.style.color = 'var(--gold)';

  sheetEls.controls.innerHTML = `<div class="field">
      <label for="character-name">الاسم</label>
      <input id="character-name" type="text" maxlength="40" value="${escapeHtml(character.name)}" autocomplete="off">
    </div>
    <div class="field">
      <label for="character-price">السعر (كوينز)</label>
      <input id="character-price" type="number" min="0" max="100000" value="${Number(character.price) || 0}">
    </div>
    <div class="field">
      <label for="character-image">تبديل الصورة (اختياري)</label>
      <input id="character-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
      <span id="character-image-note" class="card-meta">PNG أو JPEG أو WebP أو GIF · الحد 10 ميجابايت</span>
    </div>`;

  const nameInput = $('#character-name');

  const refresh = () => {
    setAction('حفظ التغييرات', {
      disabled: state.busy || nameInput.value.trim().length === 0,
      onClick: () => saveCharacterAdmin({ action: 'update', id: character.id }),
    });
  };

  nameInput.addEventListener('input', refresh);
  $('#character-image').addEventListener('change', (event) => {
    readCharacterImageFile(event.target.files?.[0], '#character-image-note').then(refresh);
  });

  sheetEls.admin.innerHTML = '<button type="button" class="danger" data-delete>حذف الشخصية</button>';
  wireDeleteCharacter(character, sheetEls.admin.querySelector('[data-delete]'));

  refresh();
}

async function readCharacterImageFile(file, noteSelector) {
  const note = $(noteSelector);

  if (!file) return null;

  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
    if (note) note.textContent = 'هذا النوع من الملفات مو مدعوم.';
    state.characterImage = null;
    return null;
  }

  if (file.size > 10 * 1024 * 1024) {
    if (note) note.textContent = `حجم الملف ${Math.ceil(file.size / 1024 / 1024)} ميجابايت، والحد 10 ميجابايت.`;
    state.characterImage = null;
    return null;
  }

  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });

  if (!dataUrl) {
    if (note) note.textContent = 'تعذّر قراءة الصورة.';
    return null;
  }

  state.characterImage = dataUrl;
  state.characterImageName = file.name;
  if (note) note.textContent = `${file.name} · ${Math.ceil(file.size / 1024)} كيلوبايت`;
  sheetEls.art.innerHTML = `<img src="${escapeHtml(dataUrl)}" alt="">`;
  setNote('الصورة جاهزة.');

  return dataUrl;
}

async function saveCharacterAdmin({ action, id = null }) {
  if (state.demo) {
    toast('وضع العرض — افتح المتجر من ديسكورد لتعديل المتجر.', 'error');
    return;
  }

  if (state.busy) return;

  const name = $('#character-name')?.value?.trim() || '';
  const price = Number($('#character-price')?.value);

  if (!name) {
    setNote('عط الشخصية اسم.', 'error');
    return;
  }

  if (!Number.isInteger(price) || price < 0) {
    setNote('السعر لازم يكون رقم صحيح من الكوينز.', 'error');
    return;
  }

  if (action === 'create' && !state.characterImage) {
    setNote('اختر صورة للشخصية.', 'error');
    return;
  }

  state.busy = true;
  setAction(action === 'create' ? 'نضيف…' : 'نحفظ…', { disabled: true });

  try {
    const body = {
      guildId: state.guildId,
      action,
      id,
      name,
      price,
    };

    if (state.characterImage) {
      body.image = state.characterImage;
      body.imageName = state.characterImageName;
    }

    const result = await api('/api/admin/character', { method: 'POST', body });

    if (!result.ok) {
      setNote(result.message || REASONS[result.reason] || 'ما انحفظت الشخصية.', 'error');
      state.busy = false;
      return;
    }

    closeSheet();
    toast(action === 'create' ? 'انضافت الشخصية.' : 'تحدّثت الشخصية.', 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
  }
}

async function deleteCharacterAdmin(character, button) {
  if (state.demo) {
    toast('وضع العرض — افتح المتجر من ديسكورد لتعديل المتجر.', 'error');
    return;
  }

  if (state.busy) return;

  state.busy = true;
  button.disabled = true;
  button.textContent = 'نحذف…';

  try {
    const result = await api('/api/admin/character', {
      method: 'POST',
      body: { guildId: state.guildId, action: 'delete', id: character.id },
    });

    if (!result.ok) {
      setNote(result.message || 'ما انحذفت الشخصية.', 'error');
      state.busy = false;
      button.disabled = false;
      button.textContent = 'اضغط مرة ثانية للحذف';
      return;
    }

    closeSheet();
    toast('انحذفت الشخصية.', 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
    button.disabled = false;
  }
}

function openReserveSettings() {
  const reserve = state.data.reserve ?? { enabled: true, price: 100 };

  openSheet(
    {
      id: 'reserve-settings',
      type: 'character',
      name: 'إعدادات الحجز',
      rarity: 'rare',
      art: null,
      summary:
        'الأعضاء يدفعون هذا السعر عشان يحجزون اسم شخصية. إذا خفيت الخيار تنشال بطاقته من المتجر، والحجوزات المعلّقة تبقى تقدر تغيّر اسمها.',
    },
    'character',
  );

  sheetEls.rarity.textContent = 'إدارة السيرفر';
  sheetEls.rarity.style.color = 'var(--gold)';

  sheetEls.controls.innerHTML = `<div class="field">
      <label for="reserve-price">السعر (كوينز)</label>
      <input id="reserve-price" type="number" min="0" max="100000" value="${Number(reserve.price) || 0}">
    </div>
    <label class="check-row">
      <input id="reserve-enabled" type="checkbox" ${reserve.enabled ? 'checked' : ''}>
      <span>أظهر «احجز شخصيتك» في المتجر</span>
    </label>`;

  setAction('حفظ الإعدادات', { onClick: saveReserveSettings });
}

async function saveReserveSettings() {
  if (state.demo) {
    toast('وضع العرض — افتح المتجر من ديسكورد لتعديل المتجر.', 'error');
    return;
  }

  if (state.busy) return;

  const price = Number($('#reserve-price')?.value);
  const enabled = Boolean($('#reserve-enabled')?.checked);

  if (!Number.isInteger(price) || price < 0) {
    setNote('السعر لازم يكون رقم صحيح من الكوينز.', 'error');
    return;
  }

  state.busy = true;
  setAction('نحفظ…', { disabled: true });

  try {
    const result = await api('/api/admin/reserve', {
      method: 'POST',
      body: { guildId: state.guildId, enabled, price },
    });

    if (!result.ok) {
      setNote(result.message || REASONS[result.reason] || 'ما انحفظت الإعدادات.', 'error');
      state.busy = false;
      return;
    }

    closeSheet();
    toast(enabled ? 'الحجوزات ظاهرة.' : 'الحجوزات مخفية.', 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
  }
}

function openReserveSheet() {
  const reserve = state.data.reserve ?? {};
  const existing = reserve.reservation ?? null;

  openSheet(
    {
      id: existing?.id ?? 'reserve',
      type: 'character',
      name: existing ? 'حجزك' : 'احجز شخصيتك',
      rarity: 'rare',
      art: null,
      summary: existing
        ? `حاجز “${existing.name}”. تقدر تغيّر الاسم لين يشوفه المشرف.`
        : reserve.enabled
          ? `ادفع ${format(reserve.price)} كوينز وترسل اسم شخصية. المشرف يراجع الحجز.`
          : 'حجز الشخصيات مقفّل حاليًا.',
    },
    'character',
  );

  sheetEls.rarity.textContent = existing ? 'بانتظار المراجعة' : reserve.enabled ? 'مفتوح' : 'مقفّل';

  if (!existing && !reserve.enabled) {
    setAction('الحجز مقفّل', { disabled: true, secondary: true });
    return;
  }

  sheetEls.controls.innerHTML = `<div class="field">
      <label for="reservation-name">اسم الشخصية</label>
      <input id="reservation-name" type="text" maxlength="40" value="${escapeHtml(existing?.name ?? '')}" placeholder="المراقب" autocomplete="off">
    </div>`;

  if (existing) {
    setAction('حفظ الاسم', { onClick: saveReservation });
  } else {
    const short = reserve.price > 0 ? balanceNote(reserve.price) : false;
    const label = reserve.price > 0 ? `احجز · ${format(reserve.price)} كوينز` : 'احجز مجانًا';

    setAction(label, { disabled: short, onClick: saveReservation });
  }
}

async function saveReservation() {
  if (state.demo) {
    toast('وضع العرض — افتح المتجر من ديسكورد للحجز.', 'error');
    return;
  }

  if (state.busy) return;

  const name = $('#reservation-name')?.value?.trim() || '';
  const existing = state.data.reserve?.reservation ?? null;

  if (!name) {
    setNote('اكتب اسم الشخصية.', 'error');
    return;
  }

  state.busy = true;
  setAction(existing ? 'نحفظ…' : 'نحجز…', { disabled: true });

  try {
    const result = await api('/api/character/reserve', {
      method: 'POST',
      body: {
        guildId: state.guildId,
        action: existing ? 'update' : 'create',
        id: existing?.id,
        name,
      },
    });

    if (!result.ok) {
      if (result.reason === 'pending') {
        closeSheet();
        toast('عندك حجز معلّق أصلاً.', 'error');
        await loadStore();
        return;
      }

      setNote(result.message || REASONS[result.reason] || 'ما انحفظ الحجز.', 'error');
      state.busy = false;
      return;
    }

    if (result.balance !== undefined) state.data.balance = result.balance;

    closeSheet();
    toast(existing ? 'تغيّر اسم الحجز.' : 'انرسل الحجز للمراجعة.', 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
  }
}

function openReservationsSheet() {
  const list = state.data.reserve?.reservations ?? [];

  openSheet(
    {
      id: 'reservations',
      type: 'character',
      name: 'الحجوزات المعلّقة',
      rarity: 'rare',
      art: null,
      summary: list.length
        ? 'كل حجوزات الشخصيات المعلّقة. العضو يقدر يغيّر اسمه لين تتم المراجعة.'
        : 'ما فيه حجوزات معلّقة حاليًا.',
    },
    'character',
  );

  sheetEls.rarity.textContent = 'إدارة السيرفر';
  sheetEls.rarity.style.color = 'var(--gold)';

  if (list.length > 0) {
    sheetEls.controls.innerHTML = `<ul class="reservation-list">${list
      .map(
        (row) => `<li>
          <strong>${escapeHtml(row.name)}</strong>
          <span>${escapeHtml(row.userName || 'عضو')} · ${escapeHtml(row.userId)} · ${new Date(row.createdAt).toLocaleDateString('ar', { day: 'numeric', month: 'long', year: 'numeric', numberingSystem: 'latn' })}</span>
        </li>`,
      )
      .join('')}</ul>`;
  }

  setAction('إغلاق', { onClick: closeSheet });
}

/* ── Demo data ────────────────────────────────────────────────────────────── */

function demoData() {
  const items = [
    {
      key: 'xp-10',
      type: 'xp',
      name: '10 خبرة',
      summary: 'يضيف 10 خبرة (50 نقطة Nightmare). العقوبات لسا تنقص من المكسب.',
      price: 40,
      amount: 10,
      limit: 0,
      stackable: false,
      needs: [],
      backgroundId: null,
      ownedCount: 0,
      atLimit: false,
      rarity: 'common',
      art: null,
    },
    {
      key: 'behavior-1',
      type: 'behavior',
      name: 'نقطة سلوك حسن',
      summary: 'يضيف نقطة سلوك حسن لبطاقتك. اشترِ أكثر من وحدة مرة وحدة بالكمية.',
      price: 100,
      amount: 1,
      limit: 0,
      stackable: true,
      needs: [],
      backgroundId: null,
      ownedCount: 0,
      atLimit: false,
      rarity: 'rare',
      art: null,
    },
    {
      key: 'profile-title',
      type: 'title',
      name: 'لقب الملف',
      summary: 'يحط اللقب على بطاقتك. اشتره مرة ثانية عشان تغيّره.',
      price: 60,
      amount: 1,
      limit: 0,
      stackable: false,
      needs: ['name'],
      backgroundId: null,
      ownedCount: 0,
      atLimit: false,
      rarity: 'common',
      art: null,
    },
    {
      key: 'emoji-slot',
      type: 'emoji',
      name: 'إيموجي سيرفر',
      summary: 'البوت يرفع الإيموجي اللي تعطيه.',
      price: 75,
      amount: 1,
      limit: 3,
      stackable: false,
      needs: ['name', 'image'],
      backgroundId: null,
      ownedCount: 1,
      atLimit: false,
      rarity: 'common',
      art: null,
    },
    {
      key: 'custom-role',
      type: 'role',
      name: 'رتبة خاصة',
      summary: 'ينشئ رتبة باسمك ولونك ويعطيك إياها.',
      price: 120,
      amount: 1,
      limit: 1,
      stackable: false,
      needs: ['name'],
      backgroundId: null,
      ownedCount: 0,
      atLimit: false,
      rarity: 'rare',
      art: null,
    },
  ];

  items.push(
    {
      key: 'design:bg-01-sakura-dusk',
      type: 'background',
      name: 'خلفية غروب الساكورا',
      summary: 'تفتح لك تصميم غروب الساكورا لبطاقة ملفك.',
      price: 130,
      defaultPrice: 130,
      amount: 1,
      limit: 1,
      stackable: false,
      needs: [],
      backgroundId: 'bg-01-sakura-dusk',
      level: 1,
      ownedCount: 0,
      atLimit: false,
      rarity: 'rare',
      art: '/assets/backgrounds/bg-01-sakura-dusk.jpg',
    },
    {
      key: 'design:bg-05-violet-storm',
      type: 'background',
      name: 'خلفية عاصفة بنفسجية',
      summary: 'تفتح لك تصميم عاصفة بنفسجية لبطاقة ملفك.',
      price: 200,
      defaultPrice: 200,
      amount: 1,
      limit: 1,
      stackable: false,
      needs: [],
      backgroundId: 'bg-05-violet-storm',
      level: 1,
      ownedCount: 1,
      atLimit: true,
      rarity: 'epic',
      art: '/assets/backgrounds/bg-05-violet-storm.jpg',
    },
    {
      key: 'design:bg-31-candy-rainbow',
      type: 'background',
      name: 'خلفية قوس حلوى',
      summary: 'تفتح لك تصميم قوس حلوى لبطاقة ملفك.',
      price: 320,
      defaultPrice: 320,
      amount: 1,
      limit: 1,
      stackable: false,
      needs: [],
      backgroundId: 'bg-31-candy-rainbow',
      level: 1,
      ownedCount: 0,
      atLimit: false,
      rarity: 'legendary',
      art: '/assets/backgrounds/bg-31-candy-rainbow.jpg',
    },
  );

  const backgrounds = [
    {
      id: 'custom',
      name: 'خلفية مخصصة',
      level: 50,
      price: 0,
      rarity: 'epic',
      art: '/assets/backgrounds/bg-08-cotton-candy.jpg',
      theme: null,
      custom: true,
      hasImage: true,
      canUpload: true,
      unlocked: true,
      owned: true,
      selected: false,
    },
    { id: 'default', name: 'الكلاسيكية', level: 1, price: 0, rarity: 'common', art: null, unlocked: true, owned: true, selected: true },
    { id: 'bg-01-sakura-dusk', name: 'غروب الساكورا', level: 1, price: 130, rarity: 'rare', art: '/assets/backgrounds/bg-01-sakura-dusk.jpg', unlocked: false, owned: false, selected: false },
    { id: 'bg-05-violet-storm', name: 'عاصفة بنفسجية', level: 1, price: 200, rarity: 'epic', art: '/assets/backgrounds/bg-05-violet-storm.jpg', unlocked: true, owned: true, selected: false },
    { id: 'bg-31-candy-rainbow', name: 'قوس حلوى', level: 1, price: 320, rarity: 'legendary', art: '/assets/backgrounds/bg-31-candy-rainbow.jpg', unlocked: false, owned: false, selected: false },
    { id: 'tier-15', name: 'مدّ', level: 15, price: 0, rarity: 'common', art: '/assets/backgrounds/tier-15.jpg', unlocked: true, owned: true, selected: false },
    { id: 'tier-20', name: 'جمشت', level: 20, price: 0, rarity: 'common', art: '/assets/backgrounds/tier-20.jpg', unlocked: false, owned: true, selected: false },
    { id: 'tier-30', name: 'شمسي', level: 30, price: 0, rarity: 'common', art: '/assets/backgrounds/tier-30.jpg', unlocked: false, owned: true, selected: false },
  ];

  const characters = [
    {
      id: 'char-watcher',
      name: 'المراقب',
      price: 150,
      rarity: 'rare',
      art: '/assets/backgrounds/bg-05-violet-storm.jpg',
      owned: false,
    },
    {
      id: 'char-oracle',
      name: 'عرّافة الرماد',
      price: 320,
      rarity: 'legendary',
      art: '/assets/backgrounds/bg-31-candy-rainbow.jpg',
      owned: true,
    },
  ];

  return {
    guild: { id: 'demo', name: 'البرج', icon: null },
    user: { id: 'demo', name: 'عضو تجريبي', username: 'demo', avatar: 'https://cdn.discordapp.com/embed/avatars/3.png' },
    balance: 420,
    level: 12,
    maxStack: 100,
    currency: 'coins',
    canManage: true,
    customLevel: 50,
    items,
    backgrounds,
    characters,
    reserve: {
      enabled: true,
      price: 120,
      hasPending: false,
      reservation: null,
      pendingCount: 1,
      reservations: [
        {
          id: 1,
          userId: 'demo-member',
          userName: 'عضو تجريبي',
          name: 'الحارس',
          status: 'pending',
          price: 120,
          createdAt: Date.now() - 86_400_000,
        },
      ],
    },
  };
}

/* ── Wire up ──────────────────────────────────────────────────────────────── */

for (const closer of document.querySelectorAll('[data-close]')) {
  closer.addEventListener('click', closeSheet);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSheet();
});

$('#boot-retry').addEventListener('click', () => {
  location.reload();
});

boot();
