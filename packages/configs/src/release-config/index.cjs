const MAIN_BRANCH_NAME = "main";
const NPM_PUBLISH = true;
// semantic-release runs in each package dir; private packages (the dashboard) are tagged, not published
const isPrivate =
  require(require("node:path").resolve("package.json")).private === true;

module.exports = {
  branches: [MAIN_BRANCH_NAME],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "angular",
        releaseRules: [
          { type: "feat", release: "minor" },
          { type: "fix", release: "patch" },
          { type: "docs", release: false },
          { type: "style", release: false },
          { type: "refactor", release: "patch" },
          { type: "perf", release: false },
          { type: "test", release: false },
          { type: "chore", release: false },
        ],
      },
    ],
    "@semantic-release/release-notes-generator",
    ["@semantic-release/npm", { npmPublish: false }],
    ...(NPM_PUBLISH && !isPrivate
      ? [
          [
            "@semantic-release/exec",
            { publishCmd: "pnpm publish --no-git-checks --access public" },
          ],
        ]
      : []),
  ],
};
