export function mergeProps(
  ...props: Record<string, unknown>[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const source of props)
    for (const [key, value] of Object.entries(source)) {
      const previous = result[key];
      if (key === "className")
        result[key] = [previous, value].filter(Boolean).join(" ");
      else if (
        /^on[A-Z]/.test(key) &&
        typeof previous === "function" &&
        typeof value === "function"
      )
        result[key] = (...args: unknown[]) => {
          (previous as (...args: unknown[]) => void)(...args);
          (value as (...args: unknown[]) => void)(...args);
        };
      else result[key] = value;
    }
  return result;
}
