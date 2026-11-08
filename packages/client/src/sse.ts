export interface Frame {
  id: string;
  event: string;
  data: string;
}

export async function readFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (f: Frame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });

  const decoder = new TextDecoder();
  let buffer = "";
  let id = "";
  let event = "";
  let data: string[] = [];
  let seen = false;

  const line = (text: string) => {
    if (text.endsWith("\r")) text = text.slice(0, -1);
    if (!text) {
      if (seen)
        onFrame({ id, event: event || "message", data: data.join("\n") });
      id = "";
      event = "";
      data = [];
      seen = false;
      return;
    }
    const colon = text.indexOf(":");
    if (colon === 0) return;
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else return;
    seen = true;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
      if (done) return;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
