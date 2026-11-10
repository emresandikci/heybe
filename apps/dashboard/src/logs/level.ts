const NAMES: Record<number, string> = {
  [-4]: "DEBUG",
  0: "INFO",
  4: "WARN",
  8: "ERROR",
};

export const levelName = (level: number) => NAMES[level] ?? String(level);
