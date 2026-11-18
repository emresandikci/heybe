import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Extracts sharp's addon and libvips (keys keep the `@img/...` layout the addon's rpath expects)
// on first use and returns the absolute path of the entry `.node` file. The parent of root must
// be private to this user: the addon is dlopened from there.
export function sharpNativeLoader(
  files: ReadonlyMap<string, string>,
  entry: string,
  version: string,
  root = join(
    tmpdir(),
    `heybe-sharp-${process.getuid?.() ?? "user"}`,
    `${version}-${process.platform}-${process.arch}`,
  ),
): () => string {
  const entryPath = join(root, entry);
  const complete = () => {
    for (const [key, source] of files) {
      try {
        if (fs.statSync(join(root, key)).size !== Bun.file(source).size)
          return false;
      } catch {
        return false;
      }
    }
    return true;
  };
  return () => {
    ensurePrivateDir(dirname(root));
    if (complete()) return entryPath;
    const temp = `${root}.${process.pid}-${crypto.randomUUID()}.tmp`;
    try {
      for (const [key, source] of files) {
        const target = join(temp, key);
        fs.mkdirSync(dirname(target), { recursive: true });
        fs.writeFileSync(target, fs.readFileSync(source));
      }
      // another process may have finished meanwhile
      if (complete()) return entryPath;
      fs.rmSync(root, { recursive: true, force: true });
      try {
        fs.renameSync(temp, root);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code !== "ENOTEMPTY" && code !== "EEXIST") || !complete())
          throw err;
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    return entryPath;
  };
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (
    !st.isDirectory() ||
    (uid !== undefined && st.uid !== uid) ||
    (process.platform !== "win32" && (st.mode & 0o077) !== 0)
  )
    throw new Error(
      `${dir} must be a directory owned by the current user with mode 0700`,
    );
}
