import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { rootDir } from '../config.js';

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

function drawXpBar(ctx, progress) {
  const ratio = Math.max(0, Math.min(1, Number(progress) / 100));

  ctx.save();
  roundedRect(ctx, TRACK);
  ctx.clip();

  // Repaint the empty track first: the template may carry a baked fill, and
  // covering it keeps 0% truly empty.
  ctx.fillStyle = TRACK_COLOR;
  ctx.fillRect(TRACK.x, TRACK.y, TRACK.width, TRACK.height);

  if (ratio > 0) {
    ctx.fillStyle = FILL_COLOR;
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

/**
 * Renders the profile card and returns a PNG buffer.
 *
 * `stats` comes from profile-store.profileStats and already contains the
 * derived rank, level, XP and punishment values.
 */
export async function renderProfileCard({ member, stats }) {
  ensureFonts();

  const [template, avatar] = await Promise.all([
    loadTemplate(),
    loadAvatar(member.avatarUrl),
  ]);

  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(template, 0, 0, CARD_WIDTH, CARD_HEIGHT);

  drawAvatar(ctx, avatar, member);
  drawName(ctx, member);

  drawTitle(ctx, stats.title);
  drawPanelValue(ctx, PANELS.rank, stats.rank ? `#${stats.rank}` : '');
  drawPanelValue(ctx, PANELS.level, stats.level);
  drawPanelValue(ctx, PANELS.vex, formatNumber(stats.vex));
  drawPanelValue(ctx, PANELS.nightmare, formatNumber(stats.nightmare));
  drawPanelValue(ctx, PANELS.punishments, formatNumber(stats.punishments));
  drawPanelValue(ctx, PANELS.behavior, formatNumber(stats.goodBehavior));
  drawXpBar(ctx, stats.progress);

  return canvas.toBuffer('image/png');
}
