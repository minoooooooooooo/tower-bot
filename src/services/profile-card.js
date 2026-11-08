import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { config, rootDir } from '../config.js';
import { effectiveDay, formatListDate, zonedDate } from '../lib/dates.js';

const ASSET_DIR = path.join(rootDir, 'assets', 'profile');
const FONT_DIR = path.join(ASSET_DIR, 'fonts');

const CARD_WIDTH = 1868;
const CARD_HEIGHT = 1200;

// The template's XP track, measured from the artwork. The track is flat
// #3c3c42, so it can be repainted without leaving a visible seam.
const TRACK = { x: 681, y: 980, width: 1059, height: 49, radius: 24 };
const TRACK_COLOR = '#3c3c42';
const FILL_COLOR = '#f4c84a';

const AVATAR = { x: 108, y: 126, size: 168 };
const NAME_BOX = { x: 300, width: 224 };
const TITLE_BOX = { left: 860, right: 1750, baseline: 198 };

// Label positions are baked into the artwork; only the values are drawn.
const PANELS = {
  rank: { x: 622, y: 292, width: 576, height: 162 },
  level: { x: 1222, y: 292, width: 573, height: 162 },
  vex: { x: 622, y: 482, width: 576, height: 166 },
  nightmare: { x: 1222, y: 482, width: 573, height: 166 },
  punishments: { x: 622, y: 676, width: 576, height: 166 },
  behavior: { x: 1222, y: 676, width: 573, height: 166 },
};

const NUMBER_FONT_SIZE = 58;
const ARABIC = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/;

// A custom wallpaper replaces the whole artwork, so its glass panels are drawn
// here instead of coming from the template. The rectangles mirror the baked
// ones closely enough that the layout does not move between backgrounds.
const CUSTOM_LAYOUT = {
  avatar: { x: 80, y: 92, width: 520, height: 1030, radius: 34 },
  title: { x: 622, y: 92, width: 1163, height: 158, radius: 30 },
  xp: { x: 622, y: 892, width: 1163, height: 216, radius: 30 },
};

const PANEL_LABELS = {
  title: 'TITLE',
  rank: 'RANK',
  level: 'LEVEL',
  vex: 'VEX POINT',
  nightmare: 'NIGHTMARE POINTS',
  punishments: 'PUNISHMENTS',
  behavior: 'GOOD BEHAVIOR',
};

// The lower-left of the template is open cloud artwork with no UI panel, so the
// status block sits directly on the art. Text carries a soft dark halo and the
// tiles are light glass, which stays legible over clouds and rainbow alike.
const STATUS_LEFT = 116;
const STATUS_RIGHT = 544;
const STATUS_WIDTH = STATUS_RIGHT - STATUS_LEFT;

const STATUS_INK = '#ffffff';
const STATUS_LABEL = 'rgba(255, 255, 255, 0.8)';
const STATUS_DIM = 'rgba(255, 255, 255, 0.68)';
const STATUS_GLASS = 'rgba(255, 255, 255, 0.13)';
const STATUS_EDGE = 'rgba(255, 255, 255, 0.36)';

const PRESENCE = {
  online: { label: 'Online', color: '#3ba55d' },
  idle: { label: 'Idle', color: '#faa81a' },
  dnd: { label: 'Do Not Disturb', color: '#ed4245' },
  offline: { label: 'Offline', color: '#8b909a' },
  streaming: { label: 'Streaming', color: '#a970ff' },
};

let templatePromise = null;

function registerFonts() {
  GlobalFonts.registerFromPath(path.join(FONT_DIR, 'Inter-Medium.otf'));
  GlobalFonts.registerFromPath(path.join(FONT_DIR, 'Inter-SemiBold.otf'));
  GlobalFonts.registerFromPath(path.join(FONT_DIR, 'Inter-ExtraBold.otf'));
  GlobalFonts.registerFromPath(path.join(FONT_DIR, 'NotoSansArabic.ttf'));
}

let fontsReady = false;

function ensureFonts() {
  if (fontsReady) return;
  registerFonts();
  fontsReady = true;
}

/** Inter for Latin, Noto Sans Arabic for names that contain Arabic. */
function familyFor(text) {
  return ARABIC.test(text) ? '"Noto Sans Arabic"' : 'Inter';
}

function fontOf(size, weight, text = '') {
  return `${weight} ${size}px ${familyFor(String(text))}`;
}

/** Shrinks the font, then truncates, so a long name never leaves the panel. */
function fitText(ctx, text, { size, weight, maxWidth, minSize = 16 }) {
  const value = String(text ?? '');

  for (let current = size; current >= minSize; current -= 1) {
    ctx.font = fontOf(current, weight, value);

    if (ctx.measureText(value).width <= maxWidth) {
      return { text: value, size: current, width: ctx.measureText(value).width };
    }
  }

  ctx.font = fontOf(minSize, weight, value);

  if (ctx.measureText(value).width <= maxWidth) {
    return { text: value, size: minSize, width: ctx.measureText(value).width };
  }

  const ellipsis = '…';
  let low = 0;
  let high = value.length;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, middle).trimEnd() + ellipsis;

    if (ctx.measureText(candidate).width <= maxWidth) low = middle;
    else high = middle - 1;
  }

  const textValue = value.slice(0, low).trimEnd() + ellipsis;
  return { text: textValue, size: minSize, width: ctx.measureText(textValue).width };
}

function roundedRect(ctx, { x, y, width, height, radius }) {
  const r = Math.min(radius, width / 2, height / 2);

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function formatNumber(value) {
  return Number(value ?? 0).toLocaleString('en-US');
}

async function loadTemplate() {
  if (!templatePromise) {
    templatePromise = readFile(path.join(ASSET_DIR, 'card.png'))
      .then((buffer) => loadImage(buffer))
      .catch((error) => {
        // Do not cache a missing asset: a redeploy that adds it should work
        // without another restart.
        templatePromise = null;
        throw error;
      });
  }

  return templatePromise;
}

/**
 * Real tier artwork is optional. A deployment can drop
 * `assets/profile/backgrounds/tier-05.png` next to the template and it wins
 * over the generated colour treatment; missing files are cached as null so the
 * common path only checks the filesystem once.
 */
const tierArtPromises = new Map();

async function loadTierArt(id) {
  if (tierArtPromises.has(id)) return tierArtPromises.get(id);

  const file = path.join(ASSET_DIR, 'backgrounds', `${id}.png`);

  if (!existsSync(file)) {
    tierArtPromises.set(id, Promise.resolve(null));
    return null;
  }

  const promise = readFile(file)
    .then((buffer) => loadImage(buffer))
    .catch(() => {
      // A broken file should not disable the card; clear the cache so a fixed
      // file is picked up without a restart.
      tierArtPromises.delete(id);
      return null;
    });

  tierArtPromises.set(id, promise);
  return promise;
}

/** Paints a theme over the template while preserving every panel and label. */
function applyTheme(ctx, theme) {
  if (!theme) return;

  ctx.save();

  const gradient = ctx.createLinearGradient(0, 0, CARD_WIDTH, CARD_HEIGHT);
  gradient.addColorStop(0, theme.from);
  gradient.addColorStop(1, theme.to);

  // "color" keeps the luminance of the artwork, so the texture and the white
  // labels survive while the palette becomes the tier's own.
  ctx.globalCompositeOperation = 'color';
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  ctx.globalCompositeOperation = 'source-over';

  const vignette = ctx.createRadialGradient(
    CARD_WIDTH / 2,
    CARD_HEIGHT / 2,
    CARD_HEIGHT * 0.2,
    CARD_WIDTH / 2,
    CARD_HEIGHT / 2,
    CARD_HEIGHT * 0.85,
  );
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  ctx.restore();
}

function drawGlassPanel(ctx, panel) {
  const radius = panel.radius ?? 24;

  ctx.save();
  roundedRect(ctx, { ...panel, radius });
  ctx.fillStyle = 'rgba(14, 16, 22, 0.58)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function drawPanelLabel(ctx, panel, label) {
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
  ctx.font = fontOf(26, 600, label);
  ctx.fillText(label, panel.x + 44, panel.y + 56);
  ctx.restore();
}

/**
 * The custom-wallpaper base: cover-crop the uploaded image, lay a soft scrim
 * over it and rebuild the glass panels so the card stays readable over any
 * picture.
 */
function drawCustomBase(ctx, image) {
  const scale = Math.max(CARD_WIDTH / image.width, CARD_HEIGHT / image.height);
  const width = image.width * scale;
  const height = image.height * scale;

  ctx.fillStyle = '#101218';
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  ctx.drawImage(
    image,
    (CARD_WIDTH - width) / 2,
    (CARD_HEIGHT - height) / 2,
    width,
    height,
  );

  // Flatten bright wallpapers just enough for white panel text and the status
  // block to keep their contrast.
  ctx.fillStyle = 'rgba(8, 10, 16, 0.3)';
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  const vignette = ctx.createRadialGradient(
    CARD_WIDTH / 2,
    CARD_HEIGHT / 2,
    CARD_HEIGHT * 0.22,
    CARD_WIDTH / 2,
    CARD_HEIGHT / 2,
    CARD_HEIGHT * 0.88,
  );
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0.05)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  drawGlassPanel(ctx, CUSTOM_LAYOUT.avatar);
  drawGlassPanel(ctx, CUSTOM_LAYOUT.title);
  drawGlassPanel(ctx, CUSTOM_LAYOUT.xp);

  for (const [key, panel] of Object.entries(PANELS)) {
    drawGlassPanel(ctx, panel);
    drawPanelLabel(ctx, panel, PANEL_LABELS[key]);
  }

  drawPanelLabel(ctx, CUSTOM_LAYOUT.title, PANEL_LABELS.title);
  drawPanelLabel(ctx, CUSTOM_LAYOUT.xp, 'XP');
}

/** Picks the authored art, the uploaded wallpaper or the generated template. */
async function backgroundImageFor(background) {
  if (background?.kind === 'custom' && background.path) {
    try {
      return { image: await loadImage(await readFile(background.path)), custom: true };
    } catch {
      // A deleted or unreadable upload falls back to the classic card.
    }
  }

  if (background?.kind === 'tier' && background.id) {
    const art = await loadTierArt(background.id);

    if (art) return { image: art, custom: false, authored: true };
  }

  return { image: await loadTemplate(), custom: false, authored: false };
}

async function loadAvatar(url) {
  if (!url) return null;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });

    if (!response.ok) return null;

    return await loadImage(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  }
}

function drawAvatar(ctx, image, member) {
  const { x, y, size } = AVATAR;

  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (image) {
    // Cover the circle without distorting the picture.
    const scale = Math.max(size / image.width, size / image.height);
    const width = image.width * scale;
    const height = image.height * scale;

    ctx.drawImage(image, x + (size - width) / 2, y + (size - height) / 2, width, height);
  } else {
    ctx.fillStyle = '#2b2b31';
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#d9d9df';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = fontOf(64, 800, member.name);
    ctx.fillText(String(member.name ?? '?').trim().charAt(0).toUpperCase() || '?', x + size / 2, y + size / 2 + 4);
  }

  ctx.restore();
}

function drawName(ctx, member) {
  const name = fitText(ctx, member.name, {
    size: 36,
    weight: 800,
    maxWidth: NAME_BOX.width,
    minSize: 20,
  });

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = fontOf(name.size, 800, name.text);
  ctx.fillText(name.text, NAME_BOX.x, 196);

  const username = fitText(ctx, `@${member.username}`, {
    size: 20,
    weight: 500,
    maxWidth: NAME_BOX.width,
    minSize: 13,
  });

  ctx.fillStyle = 'rgba(235, 235, 242, 0.72)';
  ctx.font = fontOf(username.size, 500, username.text);
  ctx.fillText(username.text, NAME_BOX.x, 228);
}

function drawTitle(ctx, title) {
  const value = title?.trim() || 'No Title';
  const fitted = fitText(ctx, value, {
    size: 42,
    weight: 600,
    maxWidth: TITLE_BOX.right - TITLE_BOX.left,
    minSize: 22,
  });

  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = fontOf(fitted.size, 600, fitted.text);
  ctx.fillText(fitted.text, TITLE_BOX.right, TITLE_BOX.baseline);
}

function drawPanelValue(ctx, panel, value) {
  if (value === null || value === undefined || value === '') return;

  const text = String(value);

  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = fontOf(NUMBER_FONT_SIZE, 800, text);
  ctx.fillText(text, panel.x + panel.width - 44, panel.y + panel.height - 34);
}

function drawXpBar(ctx, progress, accent = FILL_COLOR) {
  const ratio = Math.max(0, Math.min(1, Number(progress) / 100));

  ctx.save();
  roundedRect(ctx, TRACK);
  ctx.clip();

  // Repaint the empty track first: the template may carry a baked fill, and
  // covering it keeps 0% truly empty.
  ctx.fillStyle = TRACK_COLOR;
  ctx.fillRect(TRACK.x, TRACK.y, TRACK.width, TRACK.height);

  if (ratio > 0) {
    ctx.fillStyle = accent;
    ctx.fillRect(TRACK.x, TRACK.y, Math.max(TRACK.radius, TRACK.width * ratio), TRACK.height);
  }

  ctx.restore();

  // "37 / 100" sits just above the right end of the bar.
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.font = fontOf(26, 600, '100');
  ctx.fillText(`${progress} / 100`, TRACK.x + TRACK.width, TRACK.y - 18);
}

/** "05 Nov 2026" in the bot's time zone. */
function formatCardDate(ms) {
  if (!ms) return '—';

  const { year, month, day } = zonedDate(new Date(ms), config.timezone);
  return formatListDate(year, month, day);
}

/** "12 min ago", "3 days ago", or the date when it is older than a month. */
function formatAgo(ms, now = Date.now()) {
  if (!ms) return 'No activity yet';

  const diff = Math.max(0, now - ms);
  const minutes = Math.floor(diff / 60_000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;

  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  }

  return formatCardDate(ms);
}

/** Voice totals stay short enough for a card tile. */
function formatCardVoice(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));

  if (total < 60) return `${total}s`;

  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** Age today, not the age the member turns at their next birthday. */
function currentAge(year, month, day, timeZone, now = new Date()) {
  const today = zonedDate(now, timeZone);
  let age = today.year - year;
  const birthdayDay = effectiveDay(today.year, month, day);

  if (today.month < month || (today.month === month && today.day < birthdayDay)) {
    age -= 1;
  }

  return Math.max(0, age);
}

/** Lifts a very dark role colour so its dot is visible on the dark panel. */
function accentColor(color) {
  if (typeof color !== 'string') return '#a9adb8';

  const hex = color.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return '#a9adb8';

  const [r, g, b] = [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

  if (luminance >= 0.32) return color;

  const lift = (value) => Math.round(value + (255 - value) * 0.45);
  return `rgb(${lift(r)}, ${lift(g)}, ${lift(b)})`;
}

/** White text with a soft dark halo, so it reads on the clouds and the rainbow. */
function drawInkText(
  ctx,
  value,
  x,
  y,
  { size, weight, color = STATUS_INK, align = 'left', baseline = 'alphabetic' },
) {
  ctx.save();
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillStyle = color;
  ctx.font = fontOf(size, weight, value);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 1;
  ctx.fillText(value, x, y);
  ctx.restore();
}

function drawStatusDivider(ctx, y) {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.fillRect(STATUS_LEFT, y, STATUS_WIDTH, 1);
}

function drawStatTile(ctx, { x, y }, label, value) {
  const width = (STATUS_WIDTH - 14) / 2;
  const height = 106;

  ctx.save();
  roundedRect(ctx, { x, y, width, height, radius: 16 });
  ctx.fillStyle = STATUS_GLASS;
  ctx.fill();
  ctx.strokeStyle = STATUS_EDGE;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  drawInkText(ctx, label, x + 18, y + 34, { size: 18, weight: 700, color: STATUS_LABEL });

  const fitted = fitText(ctx, value, {
    size: 44,
    weight: 800,
    maxWidth: width - 36,
    minSize: 22,
  });

  drawInkText(ctx, fitted.text, x + 18, y + 84, { size: fitted.size, weight: 800 });
}

function drawRolePill(ctx, role, x, y, maxWidth) {
  const name = fitText(ctx, role.name, {
    size: 20,
    weight: 600,
    maxWidth: maxWidth - 44,
    minSize: 14,
  });
  const width = Math.min(maxWidth, Math.ceil(name.width) + 44);

  ctx.save();
  roundedRect(ctx, { x, y, width, height: 34, radius: 17 });
  ctx.fillStyle = STATUS_GLASS;
  ctx.fill();
  ctx.strokeStyle = STATUS_EDGE;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(x + 17, y + 17, 5, 0, Math.PI * 2);
  ctx.fillStyle = accentColor(role.color);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  drawInkText(ctx, name.text, x + 30, y + 18, {
    size: name.size,
    weight: 600,
    baseline: 'middle',
  });

  return width;
}

/**
 * The member-status block in the empty lower-left area: presence, activity,
 * totals, dates, roles, and the opt-in birthday line. Every value is optional;
 * the layout keeps fixed anchors so the card does not jump between members.
 */
function drawStatusPanel(ctx, status) {
  const now = Date.now();
  const presenceStatus = PRESENCE[status.presence?.status] ? status.presence.status : 'offline';
  const streaming = Boolean(status.presence?.streaming);
  const presence = PRESENCE[streaming ? 'streaming' : presenceStatus];
  const active = presenceStatus !== 'offline';
  const lastSeen = active
    ? 'Active now'
    : formatAgo(status.lastActiveAt ?? status.lastMessageAt, now);

  drawInkText(ctx, 'MEMBER STATUS', STATUS_LEFT, 346, {
    size: 19,
    weight: 700,
    color: STATUS_LABEL,
  });

  // Last seen shares the presence line, right-aligned.
  drawInkText(ctx, lastSeen, STATUS_RIGHT, 398, {
    size: 20,
    weight: 600,
    color: 'rgba(255, 255, 255, 0.72)',
    align: 'right',
  });
  ctx.font = fontOf(20, 600, lastSeen);
  const lastSeenWidth = ctx.measureText(lastSeen).width;

  const label = fitText(ctx, presence.label, {
    size: 46,
    weight: 700,
    maxWidth: STATUS_WIDTH - lastSeenWidth - 34,
    minSize: 26,
  });

  drawInkText(ctx, label.text, STATUS_LEFT + 28, 402, { size: label.size, weight: 700 });

  ctx.save();
  ctx.beginPath();
  ctx.arc(STATUS_LEFT + 9, 389, 9, 0, Math.PI * 2);
  ctx.fillStyle = presence.color;
  ctx.shadowColor = presence.color;
  ctx.shadowBlur = 14;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  if (status.presence?.customStatus) {
    const custom = fitText(ctx, status.presence.customStatus, {
      size: 25,
      weight: 500,
      maxWidth: STATUS_WIDTH,
      minSize: 16,
    });

    drawInkText(ctx, custom.text, STATUS_LEFT, 440, {
      size: custom.size,
      weight: 500,
      color: 'rgba(255, 255, 255, 0.9)',
    });
  }

  if (status.presence?.activity) {
    const activity = fitText(ctx, status.presence.activity, {
      size: 23,
      weight: 500,
      maxWidth: STATUS_WIDTH,
      minSize: 15,
    });

    drawInkText(ctx, activity.text, STATUS_LEFT, 470, {
      size: activity.size,
      weight: 500,
      color: STATUS_DIM,
    });
  }

  drawStatusDivider(ctx, 492);

  const tileY = 512;
  const tileWidth = (STATUS_WIDTH - 14) / 2;

  drawStatTile(ctx, { x: STATUS_LEFT, y: tileY }, 'MESSAGES', formatNumber(status.messages));
  drawStatTile(
    ctx,
    { x: STATUS_LEFT + tileWidth + 14, y: tileY },
    'VOICE TIME',
    formatCardVoice(status.voiceSeconds),
  );

  let rowY = 664;

  for (const [labelText, value] of [
    ['JOINED', formatCardDate(status.joinedAt)],
    ['ACCOUNT CREATED', formatCardDate(status.createdAt)],
  ]) {
    drawInkText(ctx, labelText, STATUS_LEFT, rowY, {
      size: 19,
      weight: 700,
      color: STATUS_LABEL,
    });

    const fitted = fitText(ctx, value, {
      size: 29,
      weight: 600,
      maxWidth: STATUS_WIDTH - 154,
      minSize: 18,
    });

    drawInkText(ctx, fitted.text, STATUS_RIGHT, rowY, {
      size: fitted.size,
      weight: 600,
      align: 'right',
    });
    rowY += 50;
  }

  const roles = Array.isArray(status.roles) ? status.roles : [];
  const birthday = status.birthday ?? null;
  const hasBirthday = Boolean(birthday?.month);
  // A birthday block always closes the panel, so the card never ends in a void.
  // The placeholder reports the member's own visibility choice without leaking
  // the date itself.
  const blockTop = hasBirthday ? 874 : 916;
  const rolesTop = 756;
  const rolesBottom = blockTop - 16;

  // Measure the pills first so a short roles list can be centred in the space
  // instead of leaving a hole above the birthday block.
  const positions = [];
  let measureX = STATUS_LEFT;
  let measureRow = 0;

  for (const role of roles) {
    if (positions.length >= 8) break;

    ctx.font = fontOf(20, 600, role.name);
    const width = Math.min(STATUS_WIDTH, ctx.measureText(role.name).width + 44);

    if (measureX > STATUS_LEFT && measureX + width > STATUS_RIGHT) {
      measureX = STATUS_LEFT;
      measureRow += 1;
    }

    positions.push({ role, x: measureX, row: measureRow });
    measureX += width + 10;
  }

  const maxRows = Math.max(1, Math.floor((rolesBottom - rolesTop - 14) / 42));
  const rows = Math.min(
    positions.length ? Math.max(...positions.map((position) => position.row)) + 1 : 0,
    maxRows,
  );
  const rolesHeight = rows > 0 ? 14 + rows * 42 : 48;
  const rolesStart = rolesTop + Math.max(0, (rolesBottom - rolesTop - rolesHeight) / 2);

  drawInkText(ctx, 'TOP ROLES', STATUS_LEFT, rolesStart + 6, {
    size: 19,
    weight: 700,
    color: STATUS_LABEL,
  });

  let drawn = 0;

  for (const { role, x, row } of positions) {
    if (row >= rows) break;
    drawRolePill(ctx, role, x, rolesStart + 22 + row * 42, STATUS_WIDTH);
    drawn += 1;
  }

  if (drawn === 0) {
    drawInkText(ctx, 'No roles', STATUS_LEFT, rolesStart + 40, {
      size: 20,
      weight: 500,
      color: STATUS_DIM,
    });
  }

  drawStatusDivider(ctx, blockTop);

  drawInkText(ctx, 'BIRTHDAY', STATUS_LEFT, blockTop + 24, {
    size: 18,
    weight: 700,
    color: STATUS_LABEL,
  });

  if (!hasBirthday) {
    const placeholder = status.birthdayHidden ? 'Hidden by member' : 'Not shared';

    drawInkText(ctx, placeholder, STATUS_LEFT, blockTop + 58, {
      size: 22,
      weight: 500,
      color: STATUS_DIM,
    });
    return;
  }

  const date = formatListDate(birthday.year ?? null, birthday.month, birthday.day);
  const age =
    birthday.year && birthday.timezone
      ? currentAge(birthday.year, birthday.month, birthday.day, birthday.timezone, now)
      : null;
  const dateText = fitText(ctx, date, {
    size: 30,
    weight: 700,
    maxWidth: age === null ? STATUS_WIDTH : STATUS_WIDTH - 108,
    minSize: 20,
  });

  drawInkText(ctx, dateText.text, STATUS_LEFT, blockTop + 58, {
    size: dateText.size,
    weight: 700,
  });

  if (age !== null) {
    drawInkText(ctx, `${age} years`, STATUS_RIGHT, blockTop + 58, {
      size: 21,
      weight: 600,
      color: STATUS_LABEL,
      align: 'right',
    });
  }

  if (birthday.timezone) {
    const zone = fitText(ctx, birthday.timezone, {
      size: 20,
      weight: 500,
      maxWidth: STATUS_WIDTH,
      minSize: 14,
    });

    drawInkText(ctx, zone.text, STATUS_LEFT, blockTop + 88, {
      size: zone.size,
      weight: 500,
      color: STATUS_DIM,
    });
  }
}

/**
 * Renders the profile card and returns a PNG buffer.
 *
 * `stats` comes from profile-store.profileStats and already contains the
 * derived rank, level, XP and punishment values. `status` is optional so older
 * callers keep working; when present it fills the lower-left member panel.
 * `background` is the descriptor from profile-backgrounds.resolveBackground:
 * a tier treatment, a custom wallpaper, or the classic template.
 */
export async function renderProfileCard({ member, stats, status = null, background = null }) {
  ensureFonts();

  const [{ image, custom, authored }, avatar] = await Promise.all([
    backgroundImageFor(background),
    loadAvatar(member.avatarUrl),
  ]);

  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext('2d');

  if (custom) {
    drawCustomBase(ctx, image);
  } else {
    ctx.drawImage(image, 0, 0, CARD_WIDTH, CARD_HEIGHT);

    // Authored tier art already carries its own palette.
    if (!authored) applyTheme(ctx, background?.theme);
  }

  drawAvatar(ctx, avatar, member);
  drawName(ctx, member);

  drawTitle(ctx, stats.title);
  drawPanelValue(ctx, PANELS.rank, stats.rank ? `#${stats.rank}` : '');
  drawPanelValue(ctx, PANELS.level, stats.level);
  drawPanelValue(ctx, PANELS.vex, formatNumber(stats.vex));
  drawPanelValue(ctx, PANELS.nightmare, formatNumber(stats.nightmare));
  drawPanelValue(ctx, PANELS.punishments, formatNumber(stats.punishments));
  drawPanelValue(ctx, PANELS.behavior, formatNumber(stats.goodBehavior));
  drawXpBar(ctx, stats.progress, background?.theme?.accent ?? FILL_COLOR);

  if (status) drawStatusPanel(ctx, status);

  return canvas.toBuffer('image/png');
}
