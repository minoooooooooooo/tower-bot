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
 * The old pipeline forced every upload to 800x514 and 16 frames. That threw
 * away most of a normal GIF's detail and duration. The limits are now a
 * *pixel-frame* budget: a small GIF may keep up to 15 seconds at its own
 * resolution, while a 1280-wide one gets roughly four seconds — the same amount
 * of decoding and encoding either way. Source timing is preserved (clamped to
 * 30 fps), the resolution follows the upload (never upscaled, capped at 1280 px
 * on the long edge), and anything past the budget is trimmed rather than
 * rejected.
 *
 * Everything is capped and every failure returns `null`, so a broken or huge
 * GIF falls back to the still image instead of breaking `/profile`.
 */

/** Longest edge of a stored animation or a rendered card. */
export const ANIMATED_MAX_WIDTH = 1280;

/** Hard ceilings. They only bind on sources that are already small. */
export const ANIMATED_MAX_FRAMES = 450;
export const ANIMATED_MAX_DURATION_MS = 15_000;

/**
 * Discord rejects bot uploads above ~10 MB, so the encoded card stays under
 * this with a little room for the multipart wrapper.
 */
export const ANIMATED_MAX_BYTES = 9.5 * 1024 * 1024;

/**
 * Decoded/encoded pixels per animation, in megapixel-frames. At 1280x822 that
 * is ~123 frames (4 s at 30 fps); at 800x514 it is ~316 (10.5 s); at 640x411
 * the 450-frame ceiling binds first. 130 MP-frames is conservative enough for
 * the AMD micro shape.
 */
export const ANIMATED_PIXEL_BUDGET = 130_000_000;

/** Widths tried in order when the encoded animation is too large. */
export const ANIMATED_STEP_WIDTHS = [1280, 1100, 960, 800];

// Card proportions, matching CARD_WIDTH/CARD_HEIGHT in profile-backgrounds.js.
// Kept local because that module imports this one.
const CARD_ASPECT = 1868 / 1200;

// GIF delays are in hundredths of a second. A delay of 0 is "as fast as
// possible" in the spec; browsers use 100 ms, so do the same. 33 ms is the
// 30 fps floor, and 10 s is the longest hold a looping card should have.
const MIN_DELAY_MS = 33;
const MAX_DELAY_MS = 10_000;
const DEFAULT_DELAY_MS = 100;

// Cheap sanity limits, applied from the header before any pixel is decoded.
const MAX_SOURCE_PIXELS = 16_000_000;
const MAX_SOURCE_FRAMES = 5_000;

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

  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DELAY_MS;

  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, raw));
}

/**
 * Reads size, frame count and total duration from the GIF metadata without
 * decoding a single pixel. Cheap enough to run before accepting an upload, and
 * the basis for every trim decision.
 *
 * Returns `null` for a still image, junk bytes, or a GIF so large that decoding
 * it would be reckless.
 */
export function readGifInfo(bytes) {
  if (!isGifBytes(bytes)) return null;

  let reader;

  try {
    reader = new GifReader(bytes);
  } catch {
    return null;
  }

  const width = reader.width;
  const height = reader.height;
  const count = reader.numFrames();

  if (!(width > 0 && height > 0) || count < 1) return null;
  if (width * height > MAX_SOURCE_PIXELS) return null;
  if (count > MAX_SOURCE_FRAMES) return null;

  let duration = 0;

  for (let i = 0; i < count; i += 1) {
    let info;

    try {
      info = reader.frameInfo(i);
    } catch {
      return null;
    }

    duration += delayOf(info);
  }

  return { width, height, frames: count, duration };
}

/**
 * The animation size derived from the upload: a card-proportioned rectangle cut
 * out of the source (cover-crop), never larger than the source, with a 1280 px
 * long-edge ceiling. A 480x308 upload stays 480x308; a 2400x1600 one becomes
 * 1280x822.
 */
export function animatedRenderSize(sourceWidth, sourceHeight, { maxWidth = ANIMATED_MAX_WIDTH } = {}) {
  if (!(sourceWidth > 0 && sourceHeight > 0)) return null;

  const sourceAspect = sourceWidth / sourceHeight;
  let width;
  let height;

  if (sourceAspect > CARD_ASPECT) {
    // Wider than the card: keep the full height and crop the sides.
    height = sourceHeight;
    width = height * CARD_ASPECT;
  } else {
    // Taller than the card: keep the full width and crop top/bottom.
    width = sourceWidth;
    height = width / CARD_ASPECT;
  }

  const scale = Math.min(1, maxWidth / Math.max(width, height));

  return {
    width: Math.max(2, Math.round(width * scale)),
    height: Math.max(2, Math.round(height * scale)),
  };
}

/** Frames allowed at a given render size, before the duration ceiling applies. */
export function animatedFrameBudget(width, height) {
  const pixels = Number(width) * Number(height);

  if (!(pixels > 0)) return 0;

  return Math.max(
    24,
    Math.min(ANIMATED_MAX_FRAMES, Math.floor(ANIMATED_PIXEL_BUDGET / pixels)),
  );
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
 * `visit` gets a reusable canvas holding the current frame plus its own delay
 * and 1-based index, and must draw from it before returning (it may also be
 * async). Every frame is kept with its source timing; the walk stops at
 * `maxFrames` or when the next frame would push the total past
 * `maxDurationMs`, so a long upload is trimmed without decoding its tail.
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
    maxSourceFrames = maxFrames,
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
  if (width * height > MAX_SOURCE_PIXELS) return null;
  if (count > MAX_SOURCE_FRAMES) return null;

  const infos = [];

  for (let i = 0; i < count; i += 1) {
    let info;

    try {
      info = reader.frameInfo(i);
    } catch {
      return null;
    }

    infos.push(info);
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(width, height);
  const pixels = new Uint8Array(width * height * 4);

  let previous = null;
  let saved = null;
  let kept = 0;
  let keptDuration = 0;

  for (let i = 0; i < count && i < maxSourceFrames; i += 1) {
    const info = infos[i];
    const delay = delayOf(info);

    // Decide the cut before decoding: the trimmed tail costs nothing.
    if (kept > 0 && (kept >= maxFrames || keptDuration + delay > maxDurationMs)) break;

    // Give the event loop a turn before the next decode/encode burst.
    if (yieldEvery > 0 && i > 0 && i % yieldEvery === 0) await yieldToEventLoop();

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
    kept += 1;
    keptDuration += delay;

    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);

    const result = visit(canvas, delay, kept);
    const keepGoing = result && typeof result.then === 'function' ? await result : result;

    if (keepGoing === false) break;
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

async function encodeAnimated(bytes, { width, height, maxFrames, maxDurationMs }) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  let encoder = null;

  const result = await eachGifFrame(
    bytes,
    (source, delay) => {
      if (!encoder) {
        encoder = new GifEncoder(width, height, {
          repeat: 0,
          quality: ANIMATED_QUALITY,
        });
      }

      ctx.fillStyle = '#101218';
      ctx.fillRect(0, 0, width, height);
      drawCover(ctx, source, width, height);

      const raw = ctx.getImageData(0, 0, width, height).data;
      encoder.addFrame(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), width, height, {
        delay,
      });
    },
    { maxFrames, maxDurationMs, maxSourceFrames: maxFrames },
  );

  if (!result || result.frames < 2 || !encoder) return null;

  return { buffer: encoder.finish(), frames: result.frames, duration: result.duration };
}

/**
 * Re-encodes an uploaded GIF as an animated wallpaper at its own resolution.
 *
 * Frame count is chosen from the pixel-frame budget at the largest size, so a
 * step-down only shrinks pixels, never shortens the loop. Source delays are
 * kept (clamped to 30 fps), and a long GIF is trimmed at the 15 s / 450-frame
 * ceiling. If the encoded file still exceeds the byte cap, the width steps down
 * through `ANIMATED_STEP_WIDTHS`; only when even 800 px is too large does this
 * return `null` and leave the still first frame.
 */
export async function normaliseAnimatedGif(bytes, { maxBytes = ANIMATED_MAX_BYTES } = {}) {
  const info = readGifInfo(bytes);

  if (!info || info.frames < 2) return null;

  const base = animatedRenderSize(info.width, info.height);

  if (!base) return null;

  const maxFrames = animatedFrameBudget(base.width, base.height);
  const widths = [base.width, ...ANIMATED_STEP_WIDTHS.filter((width) => width < base.width)];

  for (const width of widths) {
    const height = Math.max(2, Math.round((width * base.height) / base.width));
    const out = await encodeAnimated(bytes, {
      width,
      height,
      maxFrames,
      maxDurationMs: ANIMATED_MAX_DURATION_MS,
    });

    if (!out) return null;

    if (out.buffer.length <= maxBytes) {
      return {
        buffer: out.buffer,
        width,
        height,
        sourceWidth: info.width,
        sourceHeight: info.height,
        sourceDuration: info.duration,
        frames: out.frames,
        duration: out.duration,
        trimmed: out.duration < info.duration,
      };
    }
  }

  return null;
}
