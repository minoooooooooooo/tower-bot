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
  sheet: null,
  demo: false,
  busy: false,
};

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'xp', label: 'XP' },
  { id: 'behavior', label: 'Behaviour' },
  { id: 'title', label: 'Titles' },
  { id: 'role', label: 'Roles' },
  { id: 'emoji', label: 'Emoji' },
  { id: 'background', label: 'Backgrounds' },
];

const REASONS = {
  unknown: 'That item no longer exists.',
  disabled: 'This item is turned off in this server.',
  unpriced: 'This item has no price yet.',
  limit: 'You already own the maximum of that item.',
  funds: 'Not enough coins.',
  name: 'Check the name you entered.',
  color: 'That colour is not valid.',
  image: 'Choose a PNG, JPEG, WebP or GIF image.',
  size: 'The image is too large (256 KB max).',
  slots: 'The server has no free emoji slots.',
  permission: 'The bot is missing a permission for that.',
  delivery: 'Discord refused it, so your coins were refunded.',
  guild: 'The bot is not in this server.',
  member: 'You are not a member of this server.',
  database: 'Nothing was charged. Try again.',
  auth: 'Your session expired. Reopen the store.',
  server: 'The store had a problem. Try again.',
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
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 21 7v10l-9 4.5L3 17V7l9-4.5Zm0 2.3L5.2 8.2v7.6L12 19.2l6.8-3.4V8.2L12 4.8Z"/><path d="M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>';
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
    throw new Error('Could not reach the store. Check your connection.');
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok && !payload.reason) {
    throw new Error(payload.message || `Request failed (${response.status}).`);
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

    setBoot('Connecting to Discord…');
    const config = await api('/api/config', { auth: false });

    if (!config.enabled) {
      throw new Error('The store activity is not enabled for this bot yet.');
    }

    const sdk = new DiscordSDK(config.client_id);
    await sdk.ready();

    setBoot('Checking your account…');
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

    if (!token.access_token) throw new Error('Discord did not return a session.');

    await sdk.commands.authenticate({ access_token: token.access_token });

    state.sdk = sdk;
    state.token = token.access_token;
    state.guildId = sdk.guildId;

    if (!state.guildId) throw new Error('Open the store from a server, not a direct message.');

    setBoot('Loading the store…');
    await loadStore();
    showApp();
  } catch (error) {
    console.error(error);
    showFatal(error?.message || 'The store could not open.');
  }
}

async function loadStore() {
  const response = await api(`/api/store?guildId=${encodeURIComponent(state.guildId)}`);

  if (!response.ok) throw new Error(response.message || 'Could not load the store.');

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
    icon.textContent = (data.guild.name || 'S').slice(0, 1).toUpperCase();
  }

  $('#balance').textContent = format(data.balance);
  $('#avatar').src = data.user.avatar;
  $('#user-name').textContent = data.user.name;
  $('#user-level').textContent = `Level ${format(data.level)}`;

  renderTabs();
  renderGrid();
}

function renderTabs() {
  const data = state.data;
  const counts = {
    all: data.items.filter((item) => item.type !== 'background').length,
    xp: data.items.filter((item) => item.type === 'xp').length,
    behavior: data.items.filter((item) => item.type === 'behavior').length,
    title: data.items.filter((item) => item.type === 'title').length,
    role: data.items.filter((item) => item.type === 'role').length,
    emoji: data.items.filter((item) => item.type === 'emoji').length,
    background: data.backgrounds.length,
  };

  const visible = TABS.filter((tab) => tab.id === 'all' || counts[tab.id] > 0);

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

  const list = state.data.items.filter(
    (item) => item.type !== 'background' && (state.filter === 'all' || item.type === state.filter),
  );
  const grid = $('#grid');
  const empty = $('#empty');

  if (list.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    empty.textContent = 'Nothing for sale in this category.';
    return;
  }

  empty.hidden = true;
  grid.innerHTML = list.map(itemCard).join('');
  wireItemCards();
}

function itemMeta(item) {
  if (item.stackable) return 'per point';
  if (item.atLimit) return 'limit reached';
  if (item.amount > 1) return `+${format(item.amount)}`;
  if (item.needs.includes('image')) return 'upload included';
  return '';
}

function itemCard(item) {
  const badge = item.atLimit
    ? '<span class="badge">Max</span>'
    : item.ownedCount > 0
      ? `<span class="badge owned">×${format(item.ownedCount)}</span>`
      : '';

  return `<button class="card rarity-${item.rarity}" data-item="${escapeHtml(item.key)}">
    <div class="art">
      ${item.art ? `<img src="${escapeHtml(item.art)}" alt="">` : glyph(item.type)}
      <span class="rarity">${item.rarity}</span>
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

  if (list.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    empty.textContent = 'No backgrounds yet.';
    return;
  }

  empty.hidden = true;
  grid.innerHTML = list.map(backgroundCard).join('');
  wireBackgroundCards();
}

function backgroundCard(background) {
  const badge = background.selected
    ? '<span class="badge equipped">Equipped</span>'
    : background.unlocked
      ? '<span class="badge owned">Owned</span>'
      : background.price > 0
        ? ''
        : `<span class="badge">Level ${format(background.level)}</span>`;

  const price = background.selected
    ? '<span class="price free">Equipped</span>'
    : background.unlocked
      ? '<span class="price free">Tap to equip</span>'
      : background.price > 0
        ? `<span class="price">${coinSvg()}<span>${format(background.price)}</span></span>`
        : `<span class="price">Level ${format(background.level)}</span>`;

  return `<button class="card rarity-${background.rarity}" data-bg="${escapeHtml(background.id)}">
    <div class="art">
      ${background.art ? `<img src="${escapeHtml(background.art)}" alt="">` : glyph('background')}
      <span class="rarity">${background.price > 0 ? 'store design' : background.rarity}</span>
      ${badge}
    </div>
    <div class="card-body">
      <h3>${escapeHtml(background.name)}</h3>
      <span class="card-meta">${background.id === 'default' ? 'always available' : `level ${format(background.level)}`}</span>
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
  action: $('#sheet-action'),
  note: $('#sheet-note'),
};

function openSheet(item, kind) {
  state.sheet = { item, kind };
  state.image = null;
  state.imageName = null;
  sheetEls.note.textContent = '';
  sheetEls.note.className = 'sheet-note';
  sheetEls.art.style.setProperty('--rarity', `var(--${item.rarity ?? 'common'})`);
  sheetEls.art.innerHTML = item.art ? `<img src="${escapeHtml(item.art)}" alt="">` : glyph(item.type ?? 'background');
  sheetEls.rarity.textContent = item.rarity ?? 'common';
  sheetEls.rarity.style.color = `var(--${item.rarity ?? 'common'})`;
  sheetEls.title.textContent = item.name;
  sheetEls.summary.textContent = item.summary ?? '';
  sheetEls.controls.innerHTML = '';
  sheetEls.root.hidden = false;
}

function closeSheet() {
  sheetEls.root.hidden = true;
  state.sheet = null;
  state.image = null;
  state.imageName = null;
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
    setNote(`Balance: ${format(balance)} coins`);
    return false;
  }

  setNote(`Need ${format(total - balance)} more coins.`, 'error');
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
    const label = quantity > 1 ? `Buy ${quantity} · ${format(total)} coins` : `Buy · ${format(total)} coins`;

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
      <button type="button" data-step="-1" aria-label="Fewer">−</button>
      <div class="stepper-value"><strong id="qty">1</strong><small>${format(item.price)} each</small></div>
      <button type="button" data-step="1" aria-label="More">+</button>
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
      `<div class="field"><label for="title-input">Title</label>
        <input id="title-input" type="text" maxlength="32" placeholder="The Keeper" autocomplete="off"></div>`,
    );
    $('#title-input').addEventListener('input', refresh);
  }

  if (item.type === 'role') {
    sheetEls.controls.insertAdjacentHTML(
      'beforeend',
      `<div class="field"><label for="role-name">Role name</label>
        <input id="role-name" type="text" maxlength="32" placeholder="Sunset" autocomplete="off"></div>
      <div class="field"><label for="role-color">Colour</label>
        <div class="color-row">
          <input id="role-color" type="color" value="#ff8800" aria-label="Pick a colour">
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
      `<div class="field"><label for="emoji-name">Emoji name</label>
        <input id="emoji-name" type="text" maxlength="32" placeholder="tower_star" autocomplete="off"></div>
      <div class="field"><label for="emoji-file">Image</label>
        <input id="emoji-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
        <span id="image-note" class="card-meta">PNG, JPEG, WebP or GIF · 256 KB max</span></div>`,
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
    note.textContent = 'That file type is not supported.';
    state.image = null;
    return;
  }

  if (file.size > 256 * 1024) {
    note.textContent = `This file is ${Math.ceil(file.size / 1024)} KB; the limit is 256 KB.`;
    state.image = null;
    return;
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.readAsDataURL(file);
  }).catch(() => null);

  if (!dataUrl) {
    note.textContent = 'Could not read the image.';
    return;
  }

  state.image = dataUrl;
  state.imageName = file.name;
  note.textContent = `${file.name} · ${Math.ceil(file.size / 1024)} KB`;
  setNote('Image ready.');
  toast('Image ready.', 'good');
}

async function buyItem(item, values) {
  if (state.demo) {
    toast('Demo mode — open the store in Discord to buy.', 'error');
    return;
  }

  if (state.busy) return;
  state.busy = true;
  setAction('Working…', { disabled: true });

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
      setNote(result.message || REASONS[result.reason] || 'The purchase did not go through.', 'error');
      state.busy = false;
      return;
    }

    state.data.balance = result.balance ?? state.data.balance;
    closeSheet();
    toast('Purchase complete.', 'good');
    await loadStore();
  } catch (error) {
    setNote(error.message, 'error');
    state.busy = false;
  }
}

/* ── Background sheet ─────────────────────────────────────────────────────── */

function openBackgroundSheet(background) {
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
    return;
  }

  if (background.unlocked) {
    setAction('Equip', { onClick: () => equipBackground(background) });
    return;
  }

  if (background.price > 0) {
    const short = balanceNote(background.price);

    setAction(`Buy · ${format(background.price)} coins`, {
      disabled: short,
      onClick: () => buyBackground(background),
    });
    return;
  }

  setAction(`Unlocks at level ${format(background.level)}`, { disabled: true, secondary: true });
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
      rarity: 'rare',
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
      rarity: 'rare',
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
      rarity: 'epic',
      art: null,
    },
  ];

  const backgrounds = [
    { id: 'default', name: 'Classic', level: 1, price: 0, rarity: 'common', art: null, unlocked: true, owned: true, selected: true },
    { id: 'tier-15', name: 'Tide', level: 15, price: 0, rarity: 'common', art: '/assets/backgrounds/tier-15.jpg', unlocked: true, owned: true, selected: false },
    { id: 'tier-20', name: 'Amethyst', level: 20, price: 0, rarity: 'common', art: '/assets/backgrounds/tier-20.jpg', unlocked: false, owned: true, selected: false },
    { id: 'tier-30', name: 'Solaris', level: 30, price: 0, rarity: 'common', art: '/assets/backgrounds/tier-30.jpg', unlocked: false, owned: true, selected: false },
    { id: 'champion', name: "Champion's Crown", level: 40, price: 250, rarity: 'legendary', art: '/assets/backgrounds/tier-40.png', unlocked: false, owned: false, selected: false },
  ];

  return {
    guild: { id: 'demo', name: 'Tower', icon: null },
    user: { id: 'demo', name: 'Demo member', username: 'demo', avatar: 'https://cdn.discordapp.com/embed/avatars/3.png' },
    balance: 420,
    level: 12,
    maxStack: 100,
    currency: 'coins',
    items,
    backgrounds,
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
