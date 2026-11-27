# Dashboard extensions

Extensions add pages to the dashboard at `/_/`.

## Register a directory

In a file in `hb_hooks`, add an extension in `onServe`:

```ts
export default (app) => {
  app.onServe((e) => {
    e.uiExtensions.push({ name: "demo", dir: "./ui-extensions/demo" });
    return e.next();
  });
};
```

`name` and `dir` are both required. The directory is served at `/_/extensions/<name>/`, and its `main.js` is loaded by the dashboard. The file is read on every request, so edits show up without a restart.

## Add a page

```js
window.heybe.dashboard.addPage({
  path: "demo",
  title: "Demo",
  mount(el, { client }) {
    el.textContent = "Signed in as " + client.authStore.record.email;
  },
});
```

`mount` gets the element to render into and an object with `client`, a signed-in [client](/client). Return a function from `mount` to clean up when the page closes.

## Match the dashboard's look

Build the extension with React and `@heybejs/ui`:

```tsx
import { createRoot } from "react-dom/client";
import { Button } from "@heybejs/ui";
import "@heybejs/ui/style.css";

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

- `@heybejs/ui` has the styled components, `@heybejs/ui/primitives` the unstyled ones.
- Wrap the root in `ConfirmProvider` and `ToastProvider` to use `useConfirm` and `useToast`.
- With Tailwind v4, import `@heybejs/ui/theme.css` instead of `style.css`.
- Set `data-theme="dark"` on `<html>` for the dark theme.
