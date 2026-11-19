import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { createCanvas, GifEncoder } from '@napi-rs/canvas';
import { GifReader } from 'omggif';

/**
 * Animated wallpaper support.
 *
 * `@napi-rs/canvas` can encode GIFs but only decodes the first frame of one, and
 * `loadImage` on an upload silently returns a still. `omggif` fills the gap: it
 * reads frames one at a time, and this module composites them (honouring the GIF
 * disposal methods) so the profile card can be rebuilt frame by frame.
 *
 * Wallpapers are normalised to halfcard size before they are stored, which caps
 * disk use and makes rendering cheap. Everything is capped and every failure
 * returns `null`, so a broken or huge GIF falls back to the still image instead
 * of breaking `/profile`.
 */

export const ANIMATED_WIDTH = 800;
export const ANIMATED_HEIGHT = 514;
export const ANIMATED_MAX_FRAMES = 24;
export const ANIMATED_MAX_DURATION_MS = 6000;
export const ANIMATED_MAX_BYTES = 6 * 1024 * 1024;

// GIF delays are in hundredths of a second. Browsers treat 0 as "as fast as
// possible", and some encoders write absurd values; keep the card watchable.
const MIN_DELAY_MS = 40;
const MAX_DELAY_MS = 400;
export const ANIMATED_QUALITY = 18; // NeuQuant quality: 1 slowest/best, 30 fastest

/** True for the GIF87a/GIF89a magic bytes, whatever the attachment claims. */
export function isGifBytes(bytes) {
  if (!bytes || bytes.length < 6) return false;

  return (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  );
}

function delayOf(info) {
  const raw = Number(info?.delay) * 10;

  if (!Number.isFinite(raw) || raw <= 0) return 100;

  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, raw));
}

function clearFrame(pixels, width, info) {
  const left = Math.max(0, info.x);
  const top = Math.max(0, info.y);
  const right = Math.min(width, info.x + info.width);
  const height = info.height;

  for (let y = top; y < top + height; y += 1) {
    const start = (y * width + left) * 4;
    pixels.fill(0, start, start + (right - left) * 4);
  }
}

/**
 * Walks the frames of an animated GIF, compositing each one onto the previous.
 *
 * `visit` gets a reusable canvas holding the current frame plus its delay, and
 * must draw from it before returning (it may also be async). Frames are sampled
 * down to `maxFrames` / `maxDurationMs` by merging the delays of skipped frames,
 * so the animation keeps its speed even when the source has hundreds of frames.
 *
 * The loop yields to the event loop between frames. GIF decoding and encoding
 * are CPU-bound, and a profile render must never starve Discord's gateway
 * heartbeat when two members open animated cards at the same time.
 *
 * Returns `{ width, height, frames, duration }`, or `null` when the bytes are
 * not a readable animated GIF (one frame counts as still).
 */
export async function eachGifFrame(
  bytes,
  visit,
  {
    maxFrames = ANIMATED_MAX_FRAMES,
    maxDurationMs = ANIMATED_MAX_DURATION_MS,
    // Compositing needs every frame in order, so a long GIF would decode its
    // whole length. Stop at a sensible multiple of what will be kept.
    maxSourceFrames = Math.max(120, maxFrames * 8),
    yieldEvery = 1,
  } = {},
) {
  if (typeof visit !== 'function' || !isGifBytes(bytes)) return null;

  let reader;

  try {
    reader = new GifReader(bytes);
  } catch {
    return null;
  }

  const width = reader.width;
  const height = reader.height;
  const count = reader.numFrames();

  if (!(width > 0 && height > 0) || count < 2) return null;
  if (width * height > 16_000_000) return null;

  const infos = [];
  let totalDelay = 0;

  for (let i = 0; i < count; i += 1) {
    let info;

    try {
      info = reader.frameInfo(i);
    } catch {
      return null;
    }

    infos.push(info);
    totalDelay += delayOf(info);
  }

  const interval = Math.min(
    MAX_DELAY_MS,
    Math.max(MIN_DELAY_MS, Math.ceil(totalDelay / Math.max(1, maxFrames))),
  );

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(width, height);
  const pixels = new Uint8Array(width * height * 4);

  let previous = null;
  let saved = null;
  let carried = 0;
  let kept = 0;
  let keptDuration = 0;

  for (let i = 0; i < count && i < maxSourceFrames; i += 1) {
    // Give the event loop a turn before the next decode/encode burst.
    if (yieldEvery > 0 && i > 0 && i % yieldEvery === 0) await yieldToEventLoop();

    const info = infos[i];

    // Dispose of the previous frame before the next one is drawn: 2 restores
    // the background, 3 restores the canvas as it was before that frame.
    if (previous) {
      if (previous.disposal === 2) clearFrame(pixels, width, previous);
      else if (previous.disposal === 3 && saved) pixels.set(saved);
    }

    if (info.disposal === 3) saved = pixels.slice();

    try {
      reader.decodeAndBlitFrameRGBA(i, pixels);
    } catch {
      return null;
    }

    previous = info;
    carried += delayOf(info);

    if (kept > 0 && carried < interval) continue;
    if (kept > 0 && keptDuration + carried > maxDurationMs) break;

    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);

    kept += 1;
    keptDuration += carried;

    const result = visit(canvas, carried, kept);
    const keepGoing = result && typeof result.then === 'function' ? await result : result;

    if (keepGoing === false) break;
    if (kept >= maxFrames) break;

    carried = 0;
  }

  return kept > 0 ? { width, height, frames: kept, duration: keptDuration } : null;
}

/** Cover-crops `source` into `ctx` without distorting it. */
export function drawCover(ctx, source, width, height) {
  const scale = Math.max(width / source.width, height / source.height);
  const drawWidth = source.width * scale;
  const drawHeight = source.height * scale;

  ctx.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

/**
 * Re-encodes an uploaded GIF as a normalised animated wallpaper.
 *
 * Cover-crops every frame to card proportions and caps frames, duration and
 * file size. Returns `null` for a still GIF or when the result would still be
 * too large after halving the frame count.
 */
export async function normaliseAnimatedGif(bytes, { maxFrames = ANIMATED_MAX_FRAMES } = {}) {
  if (!isGifBytes(bytes)) return null;

  const attempt = async (limit) => {
    const canvas = createCanvas(ANIMATED_WIDTH, ANIMATED_HEIGHT);
    const ctx = canvas.getContext('2d');
    let encoder = null;

    const result = await eachGifFrame(
      bytes,
      (source, delay) => {
        if (!encoder) {
          encoder = new GifEncoder(ANIMATED_WIDTH, ANIMATED_HEIGHT, {
            repeat: 0,
            quality: ANIMATED_QUALITY,
          });
        }

        ctx.clearRect(0, 0, ANIMATED_WIDTH, ANIMATED_HEIGHT);
        ctx.fillStyle = '#101218';
        ctx.fillRect(0, 0, ANIMATED_WIDTH, ANIMATED_HEIGHT);
        drawCover(ctx, source, ANIMATED_WIDTH, ANIMATED_HEIGHT);

        const raw = ctx.getImageData(0, 0, ANIMATED_WIDTH, ANIMATED_HEIGHT).data;
        encoder.addFrame(
          new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
          ANIMATED_WIDTH,
          ANIMATED_HEIGHT,
          { delay },
        );
      },
      { maxFrames: limit },
    );

    if (!result || result.frames < 2) return null;

    const buffer = encoder.finish();

    return {
      buffer,
      width: ANIMATED_WIDTH,
      height: ANIMATED_HEIGHT,
      sourceWidth: result.width,
      sourceHeight: result.height,
      frames: result.frames,
      duration: result.duration,
    };
  };

  let out = await attempt(maxFrames);

  if (out && out.buffer.length > ANIMATED_MAX_BYTES) {
    out = await attempt(Math.max(6, Math.floor(maxFrames / 2)));
  }

  if (!out || out.buffer.length > ANIMATED_MAX_BYTES) return null;

  return out;
}
