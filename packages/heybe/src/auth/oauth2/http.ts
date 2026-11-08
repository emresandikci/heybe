// Reads at most `limit` bytes like Go's io.LimitReader (the rest is dropped).
export async function readCapped(
  res: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  while (reader && size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    const part = value.subarray(0, limit - size);
    chunks.push(part);
    size += part.length;
  }
  if (size >= limit) await reader?.cancel().catch(() => {});
  return new Uint8Array(Buffer.concat(chunks));
}

export const readText = async (res: Response, limit: number) =>
  new TextDecoder().decode(await readCapped(res, limit));
