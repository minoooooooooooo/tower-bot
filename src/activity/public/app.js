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
    empty.textContent = 'No backgrounds yet.';
    return;
  }

  empty.hidden = true;
  const addCard = state.data.canManage
    ? `<button class="card add-card" id="add-background">
        <div class="art">${glyph('background')}</div>
        <div class="card-body">
          <h3>Add background</h3>
          <span class="card-meta">Manage Server</span>
          <span class="price free">Upload & set a price</span>
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
      ? '<span class="badge equipped">Equipped</span>'
      : background.hasImage
        ? '<span class="badge owned">Owned</span>'
        : background.unlocked
          ? '<span class="badge">Ready</span>'
          : `<span class="badge">Level ${format(background.level)}</span>`;
    price = background.selected
      ? '<span class="price free">Equipped</span>'
      : background.hasImage || background.unlocked
        ? '<span class="price free">Tap to manage</span>'
        : `<span class="price">Level ${format(background.level)}</span>`;
    meta = background.hasImage ? 'your wallpaper' : 'upload your own';
  } else {
    badge = background.selected
      ? '<span class="badge equipped">Equipped</span>'
      : background.unlocked
        ? '<span class="badge owned">Owned</span>'
        : background.price > 0
          ? ''
          : `<span class="badge">Level ${format(background.level)}</span>`;

    price = background.selected
      ? '<span class="price free">Equipped</span>'
      : background.unlocked
        ? '<span class="price free">Tap to equip</span>'
        : background.price > 0
          ? `<span class="price">${coinSvg()}<span>${format(background.price)}</span></span>`
          : `<span class="price">Level ${format(background.level)}</span>`;

    meta =
      background.id === 'default'
        ? 'always available'
        : background.price > 0
          ? 'store design'
          : `level ${format(background.level)}`;
  }

  return `<button class="card rarity-${background.rarity}" data-bg="${escapeHtml(background.id)}">
    <div class="art">
      ${background.art ? `<img src="${escapeHtml(background.art)}" alt="" loading="lazy" decoding="async">` : glyph('background')}
      <span class="rarity">${background.price > 0 ? 'store design' : background.rarity}</span>
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
    ? '<span class="badge owned">Owned</span>'
    : character.price === 0
      ? '<span class="badge">Free</span>'
      : '';
  const price = character.owned
    ? '<span class="price free">Owned</span>'
    : character.price > 0
      ? `<span class="price">${coinSvg()}<span>${format(character.price)}</span></span>`
      : '<span class="price free">Free</span>';

  return `<button class="card character-card rarity-${character.rarity}" data-character="${escapeHtml(character.id)}">
    <div class="art portrait">
      ${character.art ? `<img src="${escapeHtml(character.art)}" alt="" loading="lazy" decoding="async">` : glyph('character')}
      <span class="rarity">character</span>
      ${badge}
    </div>
    <div class="card-body">
      <h3>${escapeHtml(character.name)}</h3>
      <span class="card-meta">collectible</span>
      ${price}
    </div>
  </button>`;
}

function addCharacterCard() {
  return `<button class="card add-card" id="add-character">
    <div class="art portrait">${glyph('character')}</div>
    <div class="card-body">
      <h3>Add character</h3>
      <span class="card-meta">Manage Server</span>
      <span class="price free">Portrait &amp; price</span>
    </div>
  </button>`;
}

function reserveSettingsCard(reserve) {
  return `<button class="card add-card" id="reserve-settings">
    <div class="art portrait">${glyph('character')}</div>
    <div class="card-body">
      <h3>Reservation settings</h3>
      <span class="card-meta">Manage Server · ${reserve.enabled ? 'visible' : 'hidden'}</span>
      <span class="price free">${reserve.price > 0 ? `${format(reserve.price)} coins` : 'Free'}</span>
    </div>
  </button>`;
}

function reservationsCard(count) {
  return `<button class="card add-card" id="character-reservations">
    <div class="art portrait">${glyph('character')}</div>
    <div class="card-body">
      <h3>Reservations</h3>
      <span class="card-meta">Manage Server</span>
      <span class="price free">${format(count)} pending</span>
    </div>
  </button>`;
}

function myReservationCard(reservation) {
  return `<button class="card character-card rarity-epic" id="character-my-reservation">
    <div class="art portrait">${glyph('character')}
      <span class="rarity">reservation</span>
      <span class="badge equipped">Pending</span>
    </div>
    <div class="card-body">
      <h3>${escapeHtml(reservation.name)}</h3>
      <span class="card-meta">your reservation</span>
      <span class="price free">Tap to rename</span>
    </div>
  </button>`;
}

function reserveCard(price) {
  return `<button class="card character-card rarity-rare" id="character-reserve">
    <div class="art portrait">${glyph('character')}
      <span class="rarity">reservation</span>
    </div>
    <div class="card-body">
      <h3>Reserve your character</h3>
      <span class="card-meta">pick a name</span>
      <span class="price ${price > 0 ? '' : 'free'}">${price > 0 ? `${coinSvg()}<span>${format(price)}</span>` : 'Free'}</span>
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
    empty.textContent = 'No characters yet.';
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
          ? `A store design. Buy it once and use it at any level.`
          : background.id === 'default'
            ? 'The classic card, always available.'
            : `Unlocks at level ${background.level}.`,
    },
    'background',
  );

  if (background.selected) {
    setAction('Currently equipped', { disabled: true, secondary: true });
  } else if (background.unlocked) {
    setAction('Equip', { onClick: () => equipBackground(background) });
  } else if (background.price > 0) {
    const short = balanceNote(background.price);

    setAction(`Buy · ${format(background.price)} coins`, {
      disabled: short,
      onClick: () => buyBackground(background),
    });
  } else {
    setAction(`Unlocks at level ${format(background.level)}`, { disabled: true, secondary: true });
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
        ? `Your uploaded wallpaper${background.selected ? ' is on your card.' : ' is ready to equip.'} You can replace it here.`
        : background.canUpload
          ? `Upload a PNG, JPEG, WebP or GIF (10 MB max). Custom wallpapers unlock at level ${level}.`
          : `Custom wallpapers unlock at level ${level}. You can upload one when you reach it.`,
    },
    'background',
  );

  if (background.canUpload || background.hasImage) {
    sheetEls.controls.innerHTML = `<div class="field">
      <label for="custom-image">${background.hasImage ? 'Replace image' : 'Wallpaper image'}</label>
      <input id="custom-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
      <span id="custom-image-note" class="card-meta">PNG, JPEG, WebP or GIF · 10 MB max${background.hasImage ? ' · GIFs stay animated' : ''}</span>
    </div>`;

    $('#custom-image').addEventListener('change', (event) => {
      readBackgroundImageFile(event.target.files?.[0], '#custom-image-note').then(refresh);
    });
  }

  function refresh() {
    if (state.backgroundImage) {
      setAction(background.hasImage ? 'Replace wallpaper' : 'Upload wallpaper', {
        disabled: state.busy,
        onClick: uploadCustomBackground,
      });
      return;
    }

    if (background.selected) {
      setAction('Currently equipped', { disabled: true, secondary: true });
      return;
    }

    if (background.hasImage) {
      setAction('Equip', { onClick: () => equipBackground(background) });
      return;
    }

    if (background.canUpload) {
      setAction('Choose an image first', { disabled: true, secondary: true });
      return;
    }

    setAction(`Unlocks at level ${level}`, { disabled: true, secondary: true });
  }

  refresh();
}

async function readBackgroundImageFile(file, noteSelector) {
  const note = $(noteSelector);

  if (!file) return null;

  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
    if (note) note.textContent = 'That file type is not supported.';
    state.backgroundImage = null;
    return null;
  }

  if (file.size > 10 * 1024 * 1024) {
    if (note) note.textContent = `This file is ${Math.ceil(file.size / 1024 / 1024)} MB; the limit is 10 MB.`;
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
    if (note) note.textContent = 'Could not read the image.';
    return null;
  }

  state.backgroundImage = dataUrl;
  state.backgroundImageName = file.name;
  if (note) note.textContent = `${file.name} · ${Math.ceil(file.size / 1024)} KB`;
  sheetEls.art.innerHTML = `<img src="${escapeHtml(dataUrl)}" alt="">`;
  setNote('Image ready.');

  return dataUrl;
}

async function uploadCustomBackground() {
  if (state.demo) {
    toast('Demo mode — open the store in Discord to change this.', 'error');
    return;
  }

  if (!state.backgroundImage) {
    setNote('Choose an image first.', 'error');
    return;
  }

  if (state.busy) return;

  state.busy = true;
  setAction('Uploading…', { disabled: true });

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
      setNote(result.message || REASONS[result.reason] || 'The wallpaper was not saved.', 'error');
      state.busy = false;
      return;
    }

    closeSheet();
    toast(
      result.animated
        ? `Custom wallpaper saved (${format(result.frames)} frames).`
        : 'Custom wallpaper saved.',
      'good',
    );
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
  }
}

function addBackgroundAdminControls(background) {
  sheetEls.admin.innerHTML = `<button type="button" data-edit>Edit</button>
    <button type="button" class="danger" data-delete>Delete</button>`;

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
      button.textContent = 'Click again to delete';
      setNote('This removes the design for everyone. Click again to confirm.', 'error');
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
      name: 'Add background',
      rarity: 'rare',
      art: null,
      summary: 'Upload a picture and set a price. It appears in the Backgrounds tab immediately.',
    },
    'background',
  );

  sheetEls.rarity.textContent = 'Manage Server';
  sheetEls.rarity.style.color = 'var(--gold)';

  sheetEls.controls.innerHTML = `<div class="field">
      <label for="bg-name">Name</label>
      <input id="bg-name" type="text" maxlength="40" placeholder="Neon Garden" autocomplete="off">
    </div>
    <div class="field">
      <label for="bg-price">Price (coins)</label>
      <input id="bg-price" type="number" min="0" max="100000" value="100">
    </div>
    <div class="field">
      <label for="bg-level">Level (for a free design)</label>
      <input id="bg-level" type="number" min="1" max="999" value="1">
    </div>
    <div class="field">
      <label for="bg-image">Image</label>
      <input id="bg-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
      <span id="bg-image-note" class="card-meta">PNG, JPEG, WebP or GIF · 10 MB max</span>
    </div>`;

  const nameInput = $('#bg-name');
  const priceInput = $('#bg-price');

  const refresh = () => {
    const ready = nameInput.value.trim().length > 0 && Boolean(state.backgroundImage);

    setAction('Add background', {
      disabled: state.busy || !ready,
      onClick: () => saveBackgroundAdmin({ action: 'create' }),
    });

    if (state.backgroundImage) {
      setNote(`Price: ${format(Number(priceInput.value) || 0)} coins`);
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
        'Rename, reprice or replace this design. Name and artwork are shared; the price is saved for this server.',
    },
    'background',
  );

  sheetEls.rarity.textContent = 'Manage Server';
  sheetEls.rarity.style.color = 'var(--gold)';

  sheetEls.controls.innerHTML = `<div class="field">
      <label for="bg-name">Name</label>
      <input id="bg-name" type="text" maxlength="40" value="${escapeHtml(background.name)}" autocomplete="off">
    </div>
    <div class="field">
      <label for="bg-price">Price (coins)</label>
      <input id="bg-price" type="number" min="0" max="100000" value="${Number(background.price) || 0}">
    </div>
    <div class="field">
      <label for="bg-level">Level (for a free design)</label>
      <input id="bg-level" type="number" min="1" max="999" value="${Number(background.level) || 1}">
    </div>
    <div class="field">
      <label for="bg-image">Replace image (optional)</label>
      <input id="bg-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
      <span id="bg-image-note" class="card-meta">PNG, JPEG, WebP or GIF · 10 MB max</span>
    </div>`;

  const nameInput = $('#bg-name');
  const refresh = () => {
    setAction('Save changes', {
      disabled: state.busy || nameInput.value.trim().length === 0,
      onClick: () => saveBackgroundAdmin({ action: 'update', id: background.id }),
    });
  };

  nameInput.addEventListener('input', refresh);
  $('#bg-image').addEventListener('change', (event) => {
    readBackgroundImageFile(event.target.files?.[0], '#bg-image-note').then(refresh);
  });

  sheetEls.admin.innerHTML = '<button type="button" class="danger" data-delete>Delete background</button>';
  wireDeleteBackground(background, sheetEls.admin.querySelector('[data-delete]'));

  refresh();
}

async function saveBackgroundAdmin({ action, id = null }) {
  if (state.demo) {
    toast('Demo mode — open the store in Discord to change the shop.', 'error');
    return;
  }

  if (state.busy) return;

  const name = $('#bg-name')?.value?.trim() || '';
  const price = Number($('#bg-price')?.value);
  const level = Number($('#bg-level')?.value);

  if (!name) {
    setNote('Give the background a name.', 'error');
    return;
  }

  if (!Number.isInteger(price) || price < 0) {
    setNote('The price must be a whole number of coins.', 'error');
    return;
  }

  if (!Number.isInteger(level) || level < 1) {
    setNote('The level must be a whole number from 1 to 999.', 'error');
    return;
  }

  if (action === 'create' && !state.backgroundImage) {
    setNote('Choose an image for the background.', 'error');
    return;
  }

  state.busy = true;
  setAction(action === 'create' ? 'Adding…' : 'Saving…', { disabled: true });

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
      setNote(result.message || REASONS[result.reason] || 'The background was not saved.', 'error');
      state.busy = false;
      return;
    }

    closeSheet();
    toast(action === 'create' ? 'Background added.' : 'Background updated.', 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
  }
}

async function deleteBackgroundAdmin(background, button) {
  if (state.demo) {
    toast('Demo mode — open the store in Discord to change the shop.', 'error');
    return;
  }

  if (state.busy) return;

  state.busy = true;
  button.disabled = true;
  button.textContent = 'Deleting…';

  try {
    const result = await api('/api/admin/background', {
      method: 'POST',
      body: { guildId: state.guildId, action: 'delete', id: background.id },
    });

    if (!result.ok) {
      setNote(result.message || 'The background was not deleted.', 'error');
      state.busy = false;
      button.disabled = false;
      button.textContent = 'Click again to delete';
      return;
    }

    closeSheet();
    toast('Background deleted.', 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
    button.disabled = false;
  }
}

async function equipBackground(background) {
  if (state.demo) {
    toast('Demo mode — open the store in Discord to equip.', 'error');
    return;
  }

  try {
    const result = await api('/api/equip', {
      method: 'POST',
      body: { guildId: state.guildId, backgroundId: background.id },
    });

    if (!result.ok) {
      setNote(result.message || 'Could not equip that background.', 'error');
      return;
    }

    closeSheet();
    toast(`${background.name} equipped.`, 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
  }
}

async function buyBackground(background) {
  if (state.demo) {
    toast('Demo mode — open the store in Discord to buy.', 'error');
    return;
  }

  const item = state.data.items.find((entry) => entry.backgroundId === background.id);

  if (!item) {
    setNote('This design is not on sale right now.', 'error');
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
        ? 'This character is in your collection.'
        : character.price > 0
          ? 'Buy this character once and keep it in your collection. Characters do not need a level.'
          : 'This character is free to claim.',
    },
    'character',
  );

  if (character.owned) {
    setAction('Owned', { disabled: true, secondary: true });
  } else if (character.price > 0) {
    const short = balanceNote(character.price);

    setAction(`Buy · ${format(character.price)} coins`, {
      disabled: short,
      onClick: () => buyCharacter(character),
    });
  } else {
    setAction('Claim for free', { onClick: () => buyCharacter(character) });
  }

  if (state.data.canManage) addCharacterAdminControls(character);
}

async function buyCharacter(character) {
  if (state.demo) {
    toast('Demo mode — open the store in Discord to buy.', 'error');
    return;
  }

  if (state.busy) return;
  state.busy = true;
  setAction('Working…', { disabled: true });

  try {
    const result = await api('/api/character/buy', {
      method: 'POST',
      body: { guildId: state.guildId, characterId: character.id },
    });

    if (!result.ok) {
      setNote(result.message || REASONS[result.reason] || 'The purchase did not go through.', 'error');
      state.busy = false;
      return;
    }

    state.data.balance = result.balance ?? state.data.balance;
    closeSheet();
    toast(`${character.name} added to your collection.`, 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
  }
}

function addCharacterAdminControls(character) {
  sheetEls.admin.innerHTML = `<button type="button" data-edit>Edit</button>
    <button type="button" class="danger" data-delete>Delete</button>`;

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
      button.textContent = 'Click again to delete';
      setNote('This removes the character for everyone. Click again to confirm.', 'error');
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
      name: 'Add character',
      rarity: 'rare',
      art: null,
      summary:
        'Upload a portrait (225 × 350 works best; any size is cropped to fit) and set a coin price.',
    },
    'character',
  );

  sheetEls.rarity.textContent = 'Manage Server';
  sheetEls.rarity.style.color = 'var(--gold)';

  sheetEls.controls.innerHTML = `<div class="field">
      <label for="character-name">Name</label>
      <input id="character-name" type="text" maxlength="40" placeholder="The Watcher" autocomplete="off">
    </div>
    <div class="field">
      <label for="character-price">Price (coins)</label>
      <input id="character-price" type="number" min="0" max="100000" value="100">
    </div>
    <div class="field">
      <label for="character-image">Portrait</label>
      <input id="character-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
      <span id="character-image-note" class="card-meta">PNG, JPEG, WebP or GIF · 10 MB max · 225 × 350 recommended</span>
    </div>`;

  const nameInput = $('#character-name');
  const priceInput = $('#character-price');

  const refresh = () => {
    const ready = nameInput.value.trim().length > 0 && Boolean(state.characterImage);

    setAction('Add character', {
      disabled: state.busy || !ready,
      onClick: () => saveCharacterAdmin({ action: 'create' }),
    });

    if (state.characterImage) {
      setNote(`Price: ${format(Number(priceInput.value) || 0)} coins`);
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
      summary: 'Rename, reprice or replace this character portrait.',
    },
    'character',
  );

  sheetEls.rarity.textContent = 'Manage Server';
  sheetEls.rarity.style.color = 'var(--gold)';

  sheetEls.controls.innerHTML = `<div class="field">
      <label for="character-name">Name</label>
      <input id="character-name" type="text" maxlength="40" value="${escapeHtml(character.name)}" autocomplete="off">
    </div>
    <div class="field">
      <label for="character-price">Price (coins)</label>
      <input id="character-price" type="number" min="0" max="100000" value="${Number(character.price) || 0}">
    </div>
    <div class="field">
      <label for="character-image">Replace portrait (optional)</label>
      <input id="character-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
      <span id="character-image-note" class="card-meta">PNG, JPEG, WebP or GIF · 10 MB max</span>
    </div>`;

  const nameInput = $('#character-name');

  const refresh = () => {
    setAction('Save changes', {
      disabled: state.busy || nameInput.value.trim().length === 0,
      onClick: () => saveCharacterAdmin({ action: 'update', id: character.id }),
    });
  };

  nameInput.addEventListener('input', refresh);
  $('#character-image').addEventListener('change', (event) => {
    readCharacterImageFile(event.target.files?.[0], '#character-image-note').then(refresh);
  });

  sheetEls.admin.innerHTML = '<button type="button" class="danger" data-delete>Delete character</button>';
  wireDeleteCharacter(character, sheetEls.admin.querySelector('[data-delete]'));

  refresh();
}

async function readCharacterImageFile(file, noteSelector) {
  const note = $(noteSelector);

  if (!file) return null;

  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
    if (note) note.textContent = 'That file type is not supported.';
    state.characterImage = null;
    return null;
  }

  if (file.size > 10 * 1024 * 1024) {
    if (note) note.textContent = `This file is ${Math.ceil(file.size / 1024 / 1024)} MB; the limit is 10 MB.`;
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
    if (note) note.textContent = 'Could not read the image.';
    return null;
  }

  state.characterImage = dataUrl;
  state.characterImageName = file.name;
  if (note) note.textContent = `${file.name} · ${Math.ceil(file.size / 1024)} KB`;
  sheetEls.art.innerHTML = `<img src="${escapeHtml(dataUrl)}" alt="">`;
  setNote('Portrait ready.');

  return dataUrl;
}

async function saveCharacterAdmin({ action, id = null }) {
  if (state.demo) {
    toast('Demo mode — open the store in Discord to change the shop.', 'error');
    return;
  }

  if (state.busy) return;

  const name = $('#character-name')?.value?.trim() || '';
  const price = Number($('#character-price')?.value);

  if (!name) {
    setNote('Give the character a name.', 'error');
    return;
  }

  if (!Number.isInteger(price) || price < 0) {
    setNote('The price must be a whole number of coins.', 'error');
    return;
  }

  if (action === 'create' && !state.characterImage) {
    setNote('Choose a portrait for the character.', 'error');
    return;
  }

  state.busy = true;
  setAction(action === 'create' ? 'Adding…' : 'Saving…', { disabled: true });

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
      setNote(result.message || REASONS[result.reason] || 'The character was not saved.', 'error');
      state.busy = false;
      return;
    }

    closeSheet();
    toast(action === 'create' ? 'Character added.' : 'Character updated.', 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
  }
}

async function deleteCharacterAdmin(character, button) {
  if (state.demo) {
    toast('Demo mode — open the store in Discord to change the shop.', 'error');
    return;
  }

  if (state.busy) return;

  state.busy = true;
  button.disabled = true;
  button.textContent = 'Deleting…';

  try {
    const result = await api('/api/admin/character', {
      method: 'POST',
      body: { guildId: state.guildId, action: 'delete', id: character.id },
    });

    if (!result.ok) {
      setNote(result.message || 'The character was not deleted.', 'error');
      state.busy = false;
      button.disabled = false;
      button.textContent = 'Click again to delete';
      return;
    }

    closeSheet();
    toast('Character deleted.', 'good');
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
      name: 'Reservation settings',
      rarity: 'rare',
      art: null,
      summary:
        'Members pay this price to reserve a character name. Hiding the option removes its card from the store; pending reservations can still be renamed.',
    },
    'character',
  );

  sheetEls.rarity.textContent = 'Manage Server';
  sheetEls.rarity.style.color = 'var(--gold)';

  sheetEls.controls.innerHTML = `<div class="field">
      <label for="reserve-price">Price (coins)</label>
      <input id="reserve-price" type="number" min="0" max="100000" value="${Number(reserve.price) || 0}">
    </div>
    <label class="check-row">
      <input id="reserve-enabled" type="checkbox" ${reserve.enabled ? 'checked' : ''}>
      <span>Show “Reserve your character” in the store</span>
    </label>`;

  setAction('Save settings', { onClick: saveReserveSettings });
}

async function saveReserveSettings() {
  if (state.demo) {
    toast('Demo mode — open the store in Discord to change the shop.', 'error');
    return;
  }

  if (state.busy) return;

  const price = Number($('#reserve-price')?.value);
  const enabled = Boolean($('#reserve-enabled')?.checked);

  if (!Number.isInteger(price) || price < 0) {
    setNote('The price must be a whole number of coins.', 'error');
    return;
  }

  state.busy = true;
  setAction('Saving…', { disabled: true });

  try {
    const result = await api('/api/admin/reserve', {
      method: 'POST',
      body: { guildId: state.guildId, enabled, price },
    });

    if (!result.ok) {
      setNote(result.message || REASONS[result.reason] || 'The settings were not saved.', 'error');
      state.busy = false;
      return;
    }

    closeSheet();
    toast(enabled ? 'Reservations are visible.' : 'Reservations are hidden.', 'good');
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
      name: existing ? 'Your reservation' : 'Reserve your character',
      rarity: 'rare',
      art: null,
      summary: existing
        ? `You reserved “${existing.name}”. You can rename it until a moderator reviews it.`
        : reserve.enabled
          ? `Pay ${format(reserve.price)} coins to submit a character name. A moderator will review the reservation.`
          : 'Character reservations are closed right now.',
    },
    'character',
  );

  sheetEls.rarity.textContent = existing ? 'Pending review' : reserve.enabled ? 'Open' : 'Closed';

  if (!existing && !reserve.enabled) {
    setAction('Reservations closed', { disabled: true, secondary: true });
    return;
  }

  sheetEls.controls.innerHTML = `<div class="field">
      <label for="reservation-name">Character name</label>
      <input id="reservation-name" type="text" maxlength="40" value="${escapeHtml(existing?.name ?? '')}" placeholder="The Watcher" autocomplete="off">
    </div>`;

  if (existing) {
    setAction('Save name', { onClick: saveReservation });
  } else {
    const short = reserve.price > 0 ? balanceNote(reserve.price) : false;
    const label = reserve.price > 0 ? `Reserve · ${format(reserve.price)} coins` : 'Reserve for free';

    setAction(label, { disabled: short, onClick: saveReservation });
  }
}

async function saveReservation() {
  if (state.demo) {
    toast('Demo mode — open the store in Discord to reserve.', 'error');
    return;
  }

  if (state.busy) return;

  const name = $('#reservation-name')?.value?.trim() || '';
  const existing = state.data.reserve?.reservation ?? null;

  if (!name) {
    setNote('Enter a character name.', 'error');
    return;
  }

  state.busy = true;
  setAction(existing ? 'Saving…' : 'Reserving…', { disabled: true });

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
        toast('You already have a pending reservation.', 'error');
        await loadStore();
        return;
      }

      setNote(result.message || REASONS[result.reason] || 'The reservation was not saved.', 'error');
      state.busy = false;
      return;
    }

    if (result.balance !== undefined) state.data.balance = result.balance;

    closeSheet();
    toast(existing ? 'Reservation renamed.' : 'Reservation submitted for review.', 'good');
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
      name: 'Pending reservations',
      rarity: 'rare',
      art: null,
      summary: list.length
        ? 'Every pending character reservation. Members can rename theirs until it is reviewed.'
        : 'No pending reservations right now.',
    },
    'character',
  );

  sheetEls.rarity.textContent = 'Manage Server';
  sheetEls.rarity.style.color = 'var(--gold)';

  if (list.length > 0) {
    sheetEls.controls.innerHTML = `<ul class="reservation-list">${list
      .map(
        (row) => `<li>
          <strong>${escapeHtml(row.name)}</strong>
          <span>${escapeHtml(row.userName || 'Member')} · ${escapeHtml(row.userId)} · ${new Date(row.createdAt).toLocaleDateString()}</span>
        </li>`,
      )
      .join('')}</ul>`;
  }

  setAction('Close', { onClick: closeSheet });
}

/* ── Demo data ────────────────────────────────────────────────────────────── */

function demoData() {
  const items = [
    {
      key: 'xp-10',
      type: 'xp',
      name: '10 XP',
      summary: 'Adds 10 XP (50 Nightmare points). Punishments still tax the gain.',
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
      name: '1 good behaviour point',
      summary: 'Adds one good behaviour point to your card.',
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
      name: 'Profile title',
      summary: 'Sets the title on your card.',
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
      name: 'Server emoji',
      summary: 'The bot uploads an emoji you provide.',
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
      name: 'Custom role',
      summary: 'Creates a role with your name and colour and gives it to you.',
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
      name: 'Sakura Dusk background',
      summary: 'Unlocks the Sakura Dusk design for your profile card.',
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
      name: 'Violet Storm background',
      summary: 'Unlocks the Violet Storm design for your profile card.',
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
      name: 'Candy Rainbow background',
      summary: 'Unlocks the Candy Rainbow design for your profile card.',
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
      name: 'Custom background',
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
    { id: 'default', name: 'Classic', level: 1, price: 0, rarity: 'common', art: null, unlocked: true, owned: true, selected: true },
    { id: 'bg-01-sakura-dusk', name: 'Sakura Dusk', level: 1, price: 130, rarity: 'rare', art: '/assets/backgrounds/bg-01-sakura-dusk.jpg', unlocked: false, owned: false, selected: false },
    { id: 'bg-05-violet-storm', name: 'Violet Storm', level: 1, price: 200, rarity: 'epic', art: '/assets/backgrounds/bg-05-violet-storm.jpg', unlocked: true, owned: true, selected: false },
    { id: 'bg-31-candy-rainbow', name: 'Candy Rainbow', level: 1, price: 320, rarity: 'legendary', art: '/assets/backgrounds/bg-31-candy-rainbow.jpg', unlocked: false, owned: false, selected: false },
    { id: 'tier-15', name: 'Tide', level: 15, price: 0, rarity: 'common', art: '/assets/backgrounds/tier-15.jpg', unlocked: true, owned: true, selected: false },
    { id: 'tier-20', name: 'Amethyst', level: 20, price: 0, rarity: 'common', art: '/assets/backgrounds/tier-20.jpg', unlocked: false, owned: true, selected: false },
    { id: 'tier-30', name: 'Solaris', level: 30, price: 0, rarity: 'common', art: '/assets/backgrounds/tier-30.jpg', unlocked: false, owned: true, selected: false },
  ];

  const characters = [
    {
      id: 'char-watcher',
      name: 'The Watcher',
      price: 150,
      rarity: 'rare',
      art: '/assets/backgrounds/bg-05-violet-storm.jpg',
      owned: false,
    },
    {
      id: 'char-oracle',
      name: 'Oracle of Ash',
      price: 320,
      rarity: 'legendary',
      art: '/assets/backgrounds/bg-31-candy-rainbow.jpg',
      owned: true,
    },
  ];

  return {
    guild: { id: 'demo', name: 'Tower', icon: null },
    user: { id: 'demo', name: 'Demo member', username: 'demo', avatar: 'https://cdn.discordapp.com/embed/avatars/3.png' },
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
          userName: 'Demo member',
          name: 'The Keeper',
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
