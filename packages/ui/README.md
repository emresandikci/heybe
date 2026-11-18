# @heybe/ui

React components of the Heybe dashboard, for building dashboard extension pages.

```sh
npm install @heybe/ui react react-dom
```

```tsx
import { createRoot } from "react-dom/client";
import { Button } from "@heybe/ui";
import "@heybe/ui/style.css";

window.heybe.dashboard.addPage({
  path: "demo",
  title: "Demo",
  mount(el) {
    const root = createRoot(el);
    root.render(<Button>Hello</Button>);
    return () => root.unmount();
  },
});
```

Use `@heybe/ui` for styled dashboard components and `@heybe/ui/primitives` for Popover, Menu, MenuItem, Tooltip, Combobox, Tabs, tabPanelIds, Switch, RadioGroup, Dialog and Placement. `ConfirmProvider` and `ToastProvider` must wrap the extension root to use `useConfirm` and `useToast`.

`style.css` is compiled Tailwind without a reset. Light is the default theme; set `data-theme="dark"` on the `html` element for dark mode.

Projects that use Tailwind v4 can import `@heybe/ui/theme.css` instead, which registers the dark variant, the code editor colors and the package sources.

## License

[MIT](LICENSE)
