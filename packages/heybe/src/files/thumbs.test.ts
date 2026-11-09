import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { localFilesystem } from "./storage";
import { createThumb, parseThumbSize, thumbGenerator } from "./thumbs";

describe("parseThumbSize", () => {
  test.each([
    ["100x100", { width: 100, height: 100, mode: "" }],
    ["0x50", { width: 0, height: 50, mode: "" }],
    ["50x0", { width: 50, height: 0, mode: "" }],
    ["100x50t", { width: 100, height: 50, mode: "t" }],
    ["100x50b", { width: 100, height: 50, mode: "b" }],
    ["100x50f", { width: 100, height: 50, mode: "f" }],
    ["0x0", { width: 0, height: 0, mode: "" }],
  ])("%s", (size, expected) => {
    expect(parseThumbSize(size)).toEqual(expected as never);
  });

  test.each(["", "100", "x100", "100x", "-1x5", "1x1x", "1x1c", " 1x1", "1X1"])(
    "%p is invalid",
    (size) => {
      expect(parseThumbSize(size)).toBeNull();
    },
  );
});

function pngWithHeaderSize(width: number, height: number): Uint8Array {
  const png = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const view = new DataView(png.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(29, crc32(png.subarray(12, 29)));
  return png;
}

describe("createThumb", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "heybe-thumbs-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const source = (format: "png" | "jpeg" | "gif" | "webp" = "png") =>
    sharp({
      create: {
        width: 200,
        height: 100,
        channels: 3,
        background: { r: 200, g: 30, b: 30 },
      },
    })
      [format]()
      .toBuffer();

  const run = async (
    size: string,
    format?: "png" | "jpeg" | "gif" | "webp",
  ) => {
    const fs = localFilesystem(root);
    await fs.write("c/r/a.img", await source(format));
    await createThumb(fs, "c/r/a.img", "c/r/thumbs_a.img/t", size);
    const bytes = await (await fs.file("c/r/thumbs_a.img/t"))!.blob.bytes();
    return sharp(bytes).metadata();
  };

  test.each([
    ["100x100", 100, 100],
    ["0x50", 100, 50],
    ["50x0", 50, 25],
    ["100x50t", 100, 50],
    ["100x50b", 100, 50],
    ["100x50f", 100, 50],
    ["50x50f", 50, 25],
    ["400x400f", 200, 100],
    ["400x400", 400, 400],
  ])("%s gives %dx%d", async (size, width, height) => {
    const meta = await run(size);
    expect([meta.width, meta.height]).toEqual([width, height]);
  });

  test("the thumb keeps the original format, webp becomes png", async () => {
    expect((await run("50x50", "jpeg")).format).toBe("jpeg");
    expect((await run("50x50", "gif")).format).toBe("gif");
    expect((await run("50x50", "webp")).format).toBe("png");
  });

  test("a size of zero by zero is rejected", async () => {
    const fs = localFilesystem(root);
    await fs.write("c/r/a.img", await source());
    await expect(
      createThumb(fs, "c/r/a.img", "c/r/t", "0x0"),
    ).rejects.toThrow();
    await expect(
      createThumb(fs, "c/r/a.img", "c/r/t", "bad"),
    ).rejects.toThrow();
  });

  test("a corrupt image rejects and writes no thumb", async () => {
    const fs = localFilesystem(root);
    await fs.write("c/r/a.png", new TextEncoder().encode("not an image"));
    await expect(
      createThumb(fs, "c/r/a.png", "c/r/t", "50x50"),
    ).rejects.toThrow();
    expect(await fs.file("c/r/t")).toBeNull();
  });

  test("a missing original rejects", async () => {
    const fs = localFilesystem(root);
    await expect(
      createThumb(fs, "c/r/none.png", "c/r/t", "50x50"),
    ).rejects.toThrow();
  });

  test("a header claiming 50000x50000 is rejected before decoding", async () => {
    const fs = localFilesystem(root);
    await fs.write("c/r/bomb.png", pngWithHeaderSize(50000, 50000));
    await expect(
      createThumb(fs, "c/r/bomb.png", "c/r/t", "50x50"),
    ).rejects.toThrow(/too large/);
    expect(await fs.file("c/r/t")).toBeNull();
  });

  describe("PB_THUMBS_MAX_SOURCE_PIXELS", () => {
    const previous = process.env.PB_THUMBS_MAX_SOURCE_PIXELS;
    afterEach(() => {
      if (previous === undefined)
        delete process.env.PB_THUMBS_MAX_SOURCE_PIXELS;
      else process.env.PB_THUMBS_MAX_SOURCE_PIXELS = previous;
    });

    test("overrides the default limit", async () => {
      const fs = localFilesystem(root);
      await fs.write("c/r/a.img", await source());
      process.env.PB_THUMBS_MAX_SOURCE_PIXELS = "19999";
      await expect(
        createThumb(fs, "c/r/a.img", "c/r/t", "50x50"),
      ).rejects.toThrow(/too large/);
      process.env.PB_THUMBS_MAX_SOURCE_PIXELS = "20000";
      await createThumb(fs, "c/r/a.img", "c/r/t", "50x50");
      expect(await fs.file("c/r/t")).not.toBeNull();
    });
  });
});

describe("thumbGenerator", () => {
  const fs = localFilesystem("/unused");

  test("concurrent requests for one thumb call the generator once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const generate = thumbGenerator(async () => {
      calls++;
      await gate;
    });
    const pending = Array.from({ length: 10 }, () =>
      generate(fs, "c/r/a.png", "c/r/thumbs_a.png/50x50_a.png", "50x50"),
    );
    release();
    await Promise.all(pending);
    expect(calls).toBe(1);

    await generate(fs, "c/r/a.png", "c/r/thumbs_a.png/50x50_a.png", "50x50");
    expect(calls).toBe(2);
  });

  test("all waiters see a failure and the next request retries", async () => {
    let fail = true;
    const generate = thumbGenerator(async () => {
      if (fail) throw new Error("boom");
    });
    const results = await Promise.allSettled([
      generate(fs, "o", "t", "1x1"),
      generate(fs, "o", "t", "1x1"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    fail = false;
    await generate(fs, "o", "t", "1x1");
  });

  test("runs at most `workers` generations at once", async () => {
    const releases: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    const generate = thumbGenerator(
      () => {
        running++;
        peak = Math.max(peak, running);
        return new Promise<void>((r) =>
          releases.push(() => {
            running--;
            r();
          }),
        );
      },
      { workers: 2 },
    );
    const all = ["a", "b", "c", "d"].map((k) => generate(fs, "o", k, "1x1"));
    await Promise.resolve();
    expect(releases.length).toBe(2);
    while (releases.length) {
      releases.shift()!();
      await new Promise((r) => setImmediate(r));
    }
    await Promise.all(all);
    expect(peak).toBe(2);
  });
});

describe("thumbGenerator max wait", () => {
  test("a generation that cannot start in time rejects", async () => {
    const fs = localFilesystem("/unused");
    let expire!: () => void;
    const generate = thumbGenerator(() => new Promise<void>(() => {}), {
      workers: 1,
      setTimer: (fn) => {
        expire = fn;
        return 0;
      },
    });
    void generate(fs, "o", "a", "1x1");
    const second = generate(fs, "o", "b", "1x1");
    expire();
    await expect(second).rejects.toThrow(/timed out/);
  });
});
