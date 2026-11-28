# AI assistants

The Heybe repository ships a skill that teaches AI assistants how to build apps on Heybe: the project layout, `hb_hooks`, queries and filters, `@heybejs/client`, API rules, migrations and the mistakes to avoid, such as writing PocketBase-only code.

The skill is a single file: [`skills/heybe/SKILL.md`](https://github.com/emresandikci/heybe/blob/main/skills/heybe/SKILL.md).

## Claude Code

Run this in your project's root folder (the folder that holds `hb_hooks` or `package.json`). It writes `.claude/skills/heybe/SKILL.md` relative to the current folder:

```bash
curl -fsSL https://raw.githubusercontent.com/emresandikci/heybe/main/skills/heybe/SKILL.md \
  --create-dirs -o .claude/skills/heybe/SKILL.md
```

To use it in every project instead, install it in your home folder:

```bash
curl -fsSL https://raw.githubusercontent.com/emresandikci/heybe/main/skills/heybe/SKILL.md \
  --create-dirs -o ~/.claude/skills/heybe/SKILL.md
```

Claude Code loads the skill when you work on Heybe code. If you run the command from Claude Code with `!`, it runs in the session's current folder, so check that folder first with `! pwd`.

## Other assistants

Add `SKILL.md` to the assistant's project instructions, for example as a rules file in Cursor or as an instruction file in other tools.

## Keeping it current

The skill follows the latest `main`. Download it again after you update Heybe.
