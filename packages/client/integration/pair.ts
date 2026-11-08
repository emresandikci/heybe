import { expect } from "bun:test";
import {
  normalize,
  startTargets,
  type Target,
} from "../../heybe/contract/harness";
import { memoryStore } from "../src/auth-store";
import { createClient, type HeybeClient } from "../src/client";
import { HeybeError } from "../src/error";

export type Name = Target["name"];

export interface Pair {
  targets: Record<Name, Target>;
  admin: Record<Name, HeybeClient>;
  client(name: Name): HeybeClient;
  stop(): Promise<void>;
}

function adminClient(target: Target): HeybeClient {
  const authStore = memoryStore();
  authStore.save(target.superToken, null);
  return createClient(target.url, { authStore });
}

export async function startPair(
  opts?: Parameters<typeof startTargets>[0],
): Promise<Pair> {
  const started = await startTargets(opts);
  const targets = { pocketbase: started.pb, heybe: started.hb };
  return {
    targets,
    admin: {
      pocketbase: adminClient(started.pb),
      heybe: adminClient(started.hb),
    },
    client: (name) => createClient(targets[name].url),
    stop: started.stop,
  };
}

export async function same(
  pair: Pair,
  fn: (c: HeybeClient, t: Target) => Promise<unknown>,
): Promise<void> {
  const run = async (name: Name) => {
    let value: unknown;
    try {
      value = await fn(pair.client(name), pair.targets[name]);
    } catch (err) {
      if (!(err instanceof HeybeError)) throw err;
      value = { error: { status: err.status, response: err.response } };
    }
    return normalize(name, value);
  };
  const [pocketbase, heybe] = await Promise.all([
    run("pocketbase"),
    run("heybe"),
  ]);
  expect(heybe).toEqual(pocketbase);
}
