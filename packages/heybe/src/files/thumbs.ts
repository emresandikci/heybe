import { availableParallelism } from "node:os";
import type { Filesystem } from "./storage";

type Mode = "" | "t" | "b" | "f";

const THUMB_SIZE = /^(\d+)x(\d+)([tbf])?$/;
const DEFAULT_MAX_SOURCE_PIXELS = 100 << 20;
const DEFAULT_MAX_WAIT_SECONDS = 60;

export function parseThumbSize(
  size: string,
): { width: number; height: number; mode: Mode } | null {
  const m = THUMB_SIZE.exec(size);
  if (!m) return null;
  return {
    width: Number(m[1]),
    height: Number(m[2]),
    mode: (m[3] ?? "") as Mode,
  };
}

const positiveEnv = (name: string, fallback: number) => {
  const n = Math.trunc(Number(process.env[name]));
  return n > 0 ? n : fallback;
};

export async function createThumb(
  fs: Filesystem,
  originalKey: string,
  thumbKey: string,
  size: string,
): Promise<void> {
  const parsed = parseThumbSize(size);
  if (!parsed)
    throw new Error("thumb size must be in WxH, WxHt, WxHb or WxHf format");
  const { width, height, mode } = parsed;
  if (width === 0 && height === 0)
    throw new Error("thumb width and height cannot be zero at the same time");

  const { default: sharp } = await import("sharp");
  const original = await fs.file(originalKey);
  if (!original) throw new Error(`original ${originalKey} does not exist`);
  // a local original goes to sharp by path instead of being read into memory
  const blob = original.blob as Blob & { name?: string };
  const input =
    !("presign" in blob) && typeof blob.name === "string"
      ? blob.name
      : await blob.bytes();

  const maxPixels = positiveEnv(
    "PB_THUMBS_MAX_SOURCE_PIXELS",
    DEFAULT_MAX_SOURCE_PIXELS,
  );
  const meta = await sharp(input, { limitInputPixels: false }).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w * h > maxPixels)
    throw new Error(
      `the original image is too large (${w}x${h}) and exceeds the total max allowed ${maxPixels} pixels`,
    );

  let image = sharp(input, { limitInputPixels: maxPixels }).rotate();
  if (width === 0 || height === 0)
    image = image.resize({
      width: width || undefined,
      height: height || undefined,
    });
  else if (mode === "f")
    image = image.resize({
      width,
      height,
      fit: "inside",
      withoutEnlargement: true,
    });
  else
    image = image.resize({
      width,
      height,
      fit: "cover",
      position: mode === "t" ? "top" : mode === "b" ? "bottom" : "centre",
    });

  const output =
    meta.format === "jpeg"
      ? image.jpeg()
      : meta.format === "gif"
        ? image.gif()
        : image.png();
  await fs.write(thumbKey, await output.toBuffer());
}

type Generate = typeof createThumb;

// Shares one generation per thumb key and limits concurrent generations, like PB's singleflight and semaphore.
export function thumbGenerator(
  generate: Generate = createThumb,
  options: {
    workers?: number;
    maxWaitMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
  } = {},
): Generate {
  const workers =
    options.workers ??
    positiveEnv("PB_THUMBS_MAX_WORKERS", availableParallelism() + 2);
  const maxWaitMs =
    options.maxWaitMs ??
    positiveEnv("PB_THUMBS_MAX_WAIT", DEFAULT_MAX_WAIT_SECONDS) * 1000;
  const setTimer = options.setTimer ?? setTimeout;
  const pending = new Map<string, Promise<void>>();
  const waiting: (() => void)[] = [];
  let running = 0;

  const acquire = () =>
    new Promise<void>((resolve, reject) => {
      if (running < workers) {
        running++;
        return resolve();
      }
      const start = () => {
        clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
        resolve();
      };
      const timer = setTimer(() => {
        waiting.splice(waiting.indexOf(start), 1);
        reject(new Error("timed out waiting to generate the thumb"));
      }, maxWaitMs);
      waiting.push(start);
    });

  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };

  return (fs, originalKey, thumbKey, size) => {
    const existing = pending.get(thumbKey);
    if (existing) return existing;
    const run = (async () => {
      await acquire();
      try {
        await generate(fs, originalKey, thumbKey, size);
      } finally {
        release();
      }
    })().finally(() => pending.delete(thumbKey));
    pending.set(thumbKey, run);
    return run;
  };
}
