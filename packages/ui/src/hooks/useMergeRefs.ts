import { useCallback, type Ref, type RefCallback } from "react";

export function useMergeRefs<T>(
  ...refs: (Ref<T> | undefined)[]
): RefCallback<T> {
  return useCallback((node: T | null) => {
    const cleanups = refs.map((ref) => {
      if (typeof ref === "function") {
        const cleanup = ref(node);
        return typeof cleanup === "function" ? cleanup : () => void ref(null);
      }
      if (ref) ref.current = node;
      return () => {
        if (ref) ref.current = null;
      };
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, refs);
}
