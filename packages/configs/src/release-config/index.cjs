const MAIN_BRANCH_NAME = "main";
const NPM_PUBLISH = false;

module.exports = {
  branches: [MAIN_BRANCH_NAME],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "angular",
        releaseRules: [
          // Pre-1.0: breaking changes bump minor so main stays on 0.x. Remove at 1.0.
          { breaking: true, release: "minor" },
          { type: "feat", release: "minor" },
          { type: "fix", release: "patch" },
          { type: "docs", release: "patch" },
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
    ...(NPM_PUBLISH
      ? [
          [
            "@semantic-release/exec",
            { publishCmd: "pnpm publish --no-git-checks --access public" },
          ],
        ]
      : []),
  ],
};
