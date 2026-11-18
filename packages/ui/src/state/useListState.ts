import { useCallback, useState } from "react";

export function useListState<K extends string>(props: {
  keys: K[];
  disabledKeys?: K[];
}) {
  const [activeKey, setActiveKey] = useState<K | null>(null);
  const enabled = props.keys.filter(
    (key) => !props.disabledKeys?.includes(key),
  );
  const first = useCallback(
    () => setActiveKey(enabled[0] ?? null),
    [enabled.join("\0")],
  );
  const last = useCallback(
    () => setActiveKey(enabled[enabled.length - 1] ?? null),
    [enabled.join("\0")],
  );
  const move = useCallback(
    (direction: number) => {
      if (!enabled.length) {
        setActiveKey(null);
        return;
      }
      const index = enabled.indexOf(activeKey as K);
      if (index === -1) {
        setActiveKey(
          direction > 0 ? enabled[0]! : enabled[enabled.length - 1]!,
        );
        return;
      }
      setActiveKey(
        enabled[(index + direction + enabled.length) % enabled.length]!,
      );
    },
    [activeKey, enabled.join("\0")],
  );
  const next = useCallback(() => move(1), [move]);
  const previous = useCallback(() => move(-1), [move]);
  return {
    activeKey,
    enabledKeys: enabled,
    setActiveKey,
    first,
    last,
    next,
    previous,
  };
}
