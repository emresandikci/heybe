# Design system

The single source of values is `packages/ui/src/theme.css` (`--hb-*` tokens, exposed to Tailwind v4 through `@theme inline`). The live preview is [`preview.html`](preview.html). The dashboard, `@heybejs/ui`, dashboard extensions and the documentation site all follow these rules.

- **Users:** developers and superusers who set up and run a backend. Desktop first, dense lists and forms, keyboard heavy. The dashboard is a tool, not a landing page.
- **Color:** quiet neutral grays carry the interface. Teal accent (`--hb-accent`, `#1b7b9b`) is only for the primary action, selection, links and focus. Red (`--hb-danger`) only for deleting and errors, green (`--hb-success`) only for a finished or healthy state, amber (`--hb-warning-*`) only for something that needs attention. Components never use raw colors, only tokens.
- **Themes:** light and dark, every color defined once per theme in `theme.css`. The user picks System, Light or Dark; the default is System. The choice is set as `data-theme` on `<html>`. In dark mode depth comes from a lighter surface (`--hb-surface-raised`), not from shadow.
- **Glass:** the sidebar and floating layers use translucent glass (`--hb-glass`, 20 px blur). Without `backdrop-filter`, with reduced transparency or forced colors, glass falls back to the solid raised surface.
- **Type:** Inter Variable, served with the app (`@fontsource-variable/inter`, no font CDN). Monospace is the system mono stack. Body and controls 14 px (`text-sm`), secondary text and labels 12.5 px (`text-xs`). `font-medium` for controls and labels, `font-semibold` for headings. No all-caps headings.
- **Code:** code areas use CodeMirror with the `--cm-*` syntax colors of the current theme. Ids, field names, filters and SQL are shown in mono.
- **Radius:** surfaces and cells 7 px (`rounded-base`), controls 8 px (`rounded-control`), badges and switches fully round.
- **Shadow:** only on floating layers (menu, popover, dialog, toast) with `--hb-shadow-overlay`; dialogs dim the page with `--hb-scrim`. Page surfaces are separated by a 1 px line (`--hb-line`), not shadow.
- **Size and spacing:** controls are 36 px (`h-9`), small controls 28 px (`h-7`). Spacing follows the Tailwind 4 px scale; inside a group `gap-2`, between groups `gap-3` or `gap-4`, panels `p-3`.
- **Icons:** Lucide (`lucide-react`), 15 px next to text, 13 px in dense rows. An icon without text has an accessible name and a tooltip.
- **Motion:** only color and opacity transitions, `--hb-duration` (150 ms). No bounce, no looping animation. With reduced motion the duration is 0.
- **Accessibility:** text at least 4.5:1 and focus at least 3:1 against its surface, enforced by `contrast.test.ts` for both themes. Every control has a visible focus ring (2 px `--hb-focus`, 2 px offset) and works with the keyboard.
- **Copy:** buttons say what they do ("Create collection", not "OK"). Errors say how to fix them. Empty states give the first step. Destructive actions are confirmed and name what is lost.
- **Components:** build with `@heybejs/ui` (Button, Badge, TextField, NumberField, Select, Combobox, Checkbox, Switch, RadioGroup, Table, Tabs, Menu, Dialog, Popover, Tooltip, Disclosure, CodeArea, FileField, EmptyState, Toasts) and `@heybejs/ui/primitives` for unstyled behavior. A new pattern goes into `@heybejs/ui` before a second screen uses it.
