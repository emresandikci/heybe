import { join } from "node:path";
import { type Target, startTargets } from "../contract/harness";

const AUTOCANNON = join(
  import.meta.dir,
  "../node_modules/autocannon/autocannon.js",
);
const RECORDS = 10_000;
const USERS = 10;
const SEED_CONCURRENCY = 50;
const CONNECTIONS = 100;
const DURATION = 10;
const WARMUP = 3;
const WORKERS = 4;
const ROUNDS = 2;
const FILE_SIZE = 50 * 1024;
const FILE_BYTES = Uint8Array.from(
  { length: FILE_SIZE },
  (_, i) => (i * 31) % 256,
);

interface Seeded {
  recordId: string;
  fileUrl: string;
}

interface Scenario {
  name: string;
  method: "GET" | "POST";
  path: (seeded: Seeded) => string;
  auth?: boolean;
  body?: string;
  expectItems?: boolean;
}

const LIST = "/api/collections/posts/records";
const scenarios: Scenario[] = [
  {
    name: "view one",
    method: "GET",
    path: ({ recordId }) => `${LIST}/${recordId}`,
  },
  {
    name: "list sorted",
    method: "GET",
    path: () => `${LIST}?perPage=30&sort=-created`,
    expectItems: true,
  },
  {
    name: "list filter status+views",
    method: "GET",
    path: () =>
      `${LIST}?filter=${encodeURIComponent('status="published" && views>100')}`,
    expectItems: true,
  },
  {
    name: "list filter author.email",
    method: "GET",
    path: () =>
      `${LIST}?filter=${encodeURIComponent('author.email="a@x.com"')}`,
    expectItems: true,
  },
  {
    name: "list expand author",
    method: "GET",
    path: () => `${LIST}?perPage=30&sort=-created&expand=author`,
    expectItems: true,
  },
  {
    name: "download 50 KB file",
    method: "GET",
    path: ({ fileUrl }) => fileUrl,
  },
  {
    name: "create",
    method: "POST",
    path: () => LIST,
    auth: true,
    body: JSON.stringify({
      title: "bench",
      body: "created during the benchmark",
      views: 1,
      status: "draft",
    }),
  },
];

interface Row {
  round: number;
  target: Target["name"];
  scenario: string;
  rps: number;
  p50: number;
  p99: number;
  non2xx: number;
  errors: number;
}

const json = (t: Target, method: string, path: string, body?: unknown) =>
  fetch(`${t.url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: t.superToken,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function mustJson(res: Response): Promise<any> {
  if (!res.ok)
    throw new Error(`${res.url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function inBatches(count: number, fn: (i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: SEED_CONCURRENCY }, async () => {
      while (next < count) await fn(next++);
    }),
  );
}

async function seed(t: Target): Promise<Seeded> {
  await mustJson(
    await json(t, "PATCH", "/api/collections/users", {
      listRule: "",
      viewRule: "",
    }),
  );
  const userIds: string[] = [];
  for (let i = 0; i < USERS; i++) {
    const email = `${String.fromCharCode(97 + i)}@x.com`;
    const user = await mustJson(
      await json(t, "POST", "/api/collections/users/records", {
        email,
        emailVisibility: true,
        password: "1234567890",
        passwordConfirm: "1234567890",
      }),
    );
    userIds.push(user.id);
  }
  await mustJson(
    await json(t, "POST", "/api/collections", {
      name: "posts",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "title", type: "text" },
        { name: "body", type: "text" },
        { name: "views", type: "number" },
        {
          name: "status",
          type: "select",
          values: ["draft", "published"],
          maxSelect: 1,
        },
        {
          name: "author",
          type: "relation",
          collectionId: "_pb_users_auth_",
          maxSelect: 1,
        },
        { name: "created", type: "autodate", onCreate: true },
      ],
    }),
  );
  await mustJson(
    await json(t, "POST", "/api/collections", {
      name: "attachments",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [{ name: "file", type: "file", maxSelect: 1, maxSize: 1048576 }],
    }),
  );
  const form = new FormData();
  form.set("file", new Blob([FILE_BYTES]), "bench.bin");
  const attachment = await mustJson(
    await fetch(`${t.url}/api/collections/attachments/records`, {
      method: "POST",
      headers: { authorization: t.superToken },
      body: form,
    }),
  );
  let firstId = "";
  await inBatches(RECORDS, async (i) => {
    const rec = await mustJson(
      await json(t, "POST", LIST, {
        title: `Post ${i}`,
        body: `Body of post ${i}. `.repeat(10),
        views: (i * 37) % 500,
        status: i % 3 === 0 ? "draft" : "published",
        author: userIds[i % USERS],
      }),
    );
    if (i === 0) firstId = rec.id;
  });
  return {
    recordId: firstId,
    fileUrl: `/api/files/attachments/${attachment.id}/${attachment.file}`,
  };
}

async function autocannon(
  t: Target,
  s: Scenario,
  seeded: Seeded,
  seconds: number,
) {
  const args = [
    AUTOCANNON,
    "--json",
    "-c",
    String(CONNECTIONS),
    "-d",
    String(seconds),
    "-w",
    String(WORKERS),
    "-m",
    s.method,
  ];
  if (s.auth) args.push("-H", `authorization=${t.superToken}`);
  if (s.body) args.push("-H", "content-type=application/json", "-b", s.body);
  args.push(`${t.url}${s.path(seeded)}`);
  const proc = Bun.spawn(["node", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`autocannon failed: ${err}`);
  const text = out.trim() ? out : err;
  return JSON.parse(text.slice(text.indexOf("{")));
}

async function checkScenarios(t: Target, seeded: Seeded) {
  const file = await fetch(`${t.url}${seeded.fileUrl}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.status !== 200 || bytes.length !== FILE_SIZE)
    throw new Error(
      `${t.name}: download returned ${file.status}, ${bytes.length} bytes`,
    );
  for (const s of scenarios) {
    if (!s.expectItems) continue;
    const body = await mustJson(await fetch(`${t.url}${s.path(seeded)}`));
    if (!(body.totalItems > 0 || body.items?.length > 0))
      throw new Error(`${t.name}: scenario "${s.name}" matched nothing`);
    if (s.name === "list sorted" && body.items.length !== 30)
      throw new Error(
        `${t.name}: sorted list returned ${body.items.length} items`,
      );
    if (s.name === "list expand author") {
      const bad = body.items.filter(
        (it: any) => typeof it.expand?.author?.email !== "string",
      );
      if (bad.length > 0 || body.items.length !== 30)
        throw new Error(`${t.name}: expand scenario did not expand authors`);
    }
  }
}

const rows: Row[] = [];

for (let round = 1; round <= ROUNDS; round++) {
  const targets = await startTargets();
  try {
    const order =
      round % 2 === 1 ? [targets.pb, targets.hb] : [targets.hb, targets.pb];
    const ids = new Map<Target["name"], Seeded>();
    for (const t of [targets.pb, targets.hb]) {
      console.error(`round ${round}: seeding ${t.name}`);
      ids.set(t.name, await seed(t));
      await checkScenarios(t, ids.get(t.name)!);
    }
    for (const s of scenarios) {
      for (const t of order) {
        const seeded = ids.get(t.name)!;
        console.error(`round ${round}: ${t.name} / ${s.name}`);
        await autocannon(t, s, seeded, WARMUP);
        const r = await autocannon(t, s, seeded, DURATION);
        rows.push({
          round,
          target: t.name,
          scenario: s.name,
          rps: Math.round(r.requests.average),
          p50: r.latency.p50,
          p99: r.latency.p99,
          non2xx: r.non2xx,
          errors: r.errors + r.timeouts,
        });
      }
    }
  } finally {
    await targets.stop();
  }
}

console.log(
  "| scenario | round | target | rps | p50 (ms) | p99 (ms) | non-2xx | errors |",
);
console.log("|---|---|---|---|---|---|---|---|");
for (const r of rows)
  console.log(
    `| ${r.scenario} | ${r.round} | ${r.target} | ${r.rps} | ${r.p50} | ${r.p99} | ${r.non2xx} | ${r.errors} |`,
  );

if (rows.some((r) => r.non2xx > 0 || r.errors > 0)) {
  console.error("FAILED: non-2xx responses or errors");
  process.exit(1);
}
