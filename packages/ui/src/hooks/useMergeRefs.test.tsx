import { fireEvent, render } from "@testing-library/react";
import { expect, mock, test } from "bun:test";
import { createRef, useState, type Ref } from "react";
import { useMergeRefs } from "./useMergeRefs.js";

function Probe(props: { a?: Ref<HTMLDivElement>; b?: Ref<HTMLDivElement> }) {
  const ref = useMergeRefs(props.a, props.b);
  return <div ref={ref} />;
}

test("useMergeRefs sets object and callback refs", () => {
  const a = createRef<HTMLDivElement>();
  const b = mock((_node: HTMLDivElement | null) => {});
  const { container, unmount } = render(<Probe a={a} b={b} />);
  expect(a.current).toBe(container.firstChild as HTMLDivElement);
  expect(b).toHaveBeenCalledWith(container.firstChild);
  unmount();
  expect(a.current).toBeNull();
  expect(b).toHaveBeenLastCalledWith(null);
});

test("useMergeRefs returns a stable callback while the refs are unchanged", () => {
  const a = createRef<HTMLDivElement>();
  const seen: unknown[] = [];
  function Stable() {
    const [, setTick] = useState(0);
    const ref = useMergeRefs(a);
    seen.push(ref);
    return <div ref={ref} onClick={() => setTick((n) => n + 1)} />;
  }
  const { container } = render(<Stable />);
  fireEvent.click(container.firstChild as HTMLDivElement);
  expect(seen.length).toBeGreaterThan(1);
  expect(seen[1]).toBe(seen[0]);
});

test("useMergeRefs runs cleanup functions returned by callback refs", () => {
  const cleanup = mock(() => {});
  const plain = mock((_node: HTMLDivElement | null) => {});
  const { unmount } = render(<Probe a={() => cleanup} b={plain} />);
  unmount();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(plain).toHaveBeenLastCalledWith(null);
});
