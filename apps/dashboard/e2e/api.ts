import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { state } from "./state";

const storage = fileURLToPath(new URL(".auth/superuser.json", import.meta.url));

function token(): string {
  const { origins } = JSON.parse(readFileSync(storage, "utf8")) as {
    origins: { localStorage: { name: string; value: string }[] }[];
  };
  const entry = origins
    .flatMap((o) => o.localStorage)
    .find((e) => e.name === "hb_superuser_auth");
  if (!entry) throw new Error("No superuser session in the storage state");
  return JSON.parse(entry.value).token;
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(state().url + path, {
    ...init,
    headers: {
      Authorization: token(),
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!res.ok)
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`,
    );
  return (res.status === 204 ? undefined : await res.json()) as T;
}
