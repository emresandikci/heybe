import { appendFileSync } from "node:fs";
import { Writable } from "node:stream";
import semanticRelease from "semantic-release";

const MARKER = "<!-- release-preview -->";
const PACKAGES = [
  "packages/core",
  "packages/client",
  "packages/query",
  "packages/ui",
  "apps/dashboard",
];

const {
  BASE_REF: baseRef,
  HEAD_REF: headRef,
  HEAD_SHA: headSha = "",
  PR_NUMBER: prNumber,
  COMMENT: comment,
  GITHUB_REPOSITORY: repository,
  GITHUB_TOKEN: token,
  GITHUB_API_URL: apiUrl = "https://api.github.com",
  GITHUB_STEP_SUMMARY: summaryFile,
  GITHUB_ACTIONS,
  ...env
} = process.env;

if (!baseRef) throw new Error("BASE_REF is required");

const silent = new Writable({ write: (_chunk, _enc, done) => done() });
const remote = `https://github.com/${repository ?? "emresandikci/heybe"}.git`;
// git reaches the remote through the local clone, so the dry run's push check needs no
// push access and fork PRs work too; the notes still link to GitHub.
const gitEnv = {
  ...env,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: `url.${process.cwd()}.insteadOf`,
  GIT_CONFIG_VALUE_0: remote,
};

const root = process.cwd();

async function preview(dir) {
  const cwd = `${root}/${dir}`;
  const { name } = (
    await import(`${cwd}/package.json`, { with: { type: "json" } })
  ).default;
  // semantic-release-monorepo finds the package from process.cwd()
  process.chdir(cwd);
  try {
    const result = await semanticRelease(
      {
        dryRun: true,
        ci: false,
        extends: "semantic-release-monorepo",
        repositoryUrl: remote,
      },
      { cwd, env: gitEnv, stdout: silent, stderr: silent },
    );
    return { name, result };
  } finally {
    process.chdir(root);
  }
}

const results = [];
for (const dir of PACKAGES) results.push(await preview(dir));

const code = (v) => `\`${v}\``;
const lines = [
  MARKER,
  "### 📦 Release preview",
  "",
  `${code(headRef)} → ${code(baseRef)}`,
  "",
  "| Package | Current | Next | Bump |",
  "|---|---|---|---|",
];
for (const { name, result } of results) {
  const current = result ? result.lastRelease?.version : undefined;
  lines.push(
    result
      ? `| ${code(name)} | ${current ? code(current) : "_none_"} | **${code(result.nextRelease.version)}** | ${code(result.nextRelease.type)} |`
      : `| ${code(name)} | | no release | |`,
  );
}
for (const { name, result } of results) {
  if (!result) continue;
  lines.push(
    "",
    `<details><summary><code>${name}</code> release notes</summary>`,
    "",
    result.nextRelease.notes,
    "",
    "</details>",
  );
}
lines.push(
  "",
  `<sub>semantic-release dry run · ${headSha.slice(0, 7) || "HEAD"}</sub>`,
);
const body = lines.join("\n");

if (summaryFile) appendFileSync(summaryFile, `${body}\n`);
else console.log(body);

if (comment === "true") {
  const api = async (path, init = {}) => {
    const res = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    if (!res.ok)
      throw new Error(
        `${init.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`,
      );
    return res.json();
  };
  let existing;
  for (let page = 1; !existing; page++) {
    const comments = await api(
      `/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );
    existing = comments.find(
      (c) => c.user?.type === "Bot" && c.body?.includes(MARKER),
    );
    if (comments.length < 100) break;
  }
  const payload = {
    method: existing ? "PATCH" : "POST",
    body: JSON.stringify({ body }),
  };
  await api(
    existing
      ? `/repos/${repository}/issues/comments/${existing.id}`
      : `/repos/${repository}/issues/${prNumber}/comments`,
    payload,
  );
}
