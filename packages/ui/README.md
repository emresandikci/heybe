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

`style.css` is compiled Tailwind without a reset. Dark mode follows `data-theme="dark"` on the root element.

Projects that use Tailwind v4 can import `@heybe/ui/theme.css` instead, which registers the dark variant, the code editor colors and the package sources.

## License

[MIT](LICENSE)
