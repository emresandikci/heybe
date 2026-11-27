import { describe, expect, test } from "bun:test";
import { readFrames, type Frame } from "./sse.js";

const bytes = (text: string) => new TextEncoder().encode(text);

async function read(...chunks: (string | Uint8Array)[]): Promise<Frame[]> {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks)
        c.enqueue(typeof chunk === "string" ? bytes(chunk) : chunk);
      c.close();
    },
  });
  const frames: Frame[] = [];
  await readFrames(body, (f) => frames.push(f));
  return frames;
}

describe("readFrames", () => {
  test("one frame per blank line", async () => {
    expect(
      await read("id:a\nevent:HB_CONNECT\ndata:{}\n\nevent:x\ndata:1\n\n"),
    ).toEqual([
      { id: "a", event: "HB_CONNECT", data: "{}" },
      { id: "", event: "x", data: "1" },
    ]);
  });

  test("frame split mid-line across chunks", async () => {
    expect(
      await read("ev", "ent: posts/*\nda", 'ta: {"a"', ":1}\n", "\n"),
    ).toEqual([{ id: "", event: "posts/*", data: '{"a":1}' }]);
  });

  test("\\r\\n split between chunks", async () => {
    expect(await read("event:x\r", "\ndata:1\r\n\r", "\n")).toEqual([
      { id: "", event: "x", data: "1" },
    ]);
  });

  test("multi-byte UTF-8 character split between chunks", async () => {
    const all = bytes("data:ğü€\n\n");
    const frames = await read(all.slice(0, 6), all.slice(6, 9), all.slice(9));
    expect(frames).toEqual([{ id: "", event: "message", data: "ğü€" }]);
  });

  test("several frames in one chunk", async () => {
    const frames = await read("data:1\n\ndata:2\n\ndata:3\n\n");
    expect(frames.map((f) => f.data)).toEqual(["1", "2", "3"]);
  });

  test("multi-line data", async () => {
    expect(await read("data: a\ndata:  b\ndata\n\n")).toEqual([
      { id: "", event: "message", data: "a\n b\n" },
    ]);
  });

  test("comments ignored", async () => {
    expect(await read(": ping\n\n:x\ndata:1\n\n")).toEqual([
      { id: "", event: "message", data: "1" },
    ]);
  });
});
