import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
} from "react";
import {
  EditorContent,
  useEditor,
  useEditorState,
  type Editor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  Code2,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
} from "lucide-react";
import {
  Button,
  CodeArea,
  FieldShell,
  Popover,
  Tooltip,
  useFieldIds,
} from "@heybe/ui";
import type { EditorInputProps } from "./EditorInput";

const ALIASES: Record<string, string> = {
  b: "strong",
  i: "em",
  strike: "s",
  del: "s",
};

function canonical(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE)
    return (node.textContent ?? "").replace(/\s+/g, " ");
  if (!(node instanceof Element)) return "";
  const tag = node.tagName.toLowerCase();
  const ignored = tag === "a" ? ["target", "rel"] : [];
  const attrs = [...node.attributes]
    .filter((a) => !ignored.includes(a.name))
    .map((a) => `${a.name}=${a.value}`)
    .sort()
    .join(" ");
  const inner = [...node.childNodes].map(canonical).join("");
  return `<${ALIASES[tag] ?? tag} ${attrs}>${inner}</>`;
}

function normalized(html: string) {
  const box = document.createElement("div");
  box.innerHTML = html;
  return [...box.childNodes]
    .map(canonical)
    .join("")
    .replace(/>\s+</g, "><")
    .trim();
}

const survives = (editor: Editor, value: string) =>
  value === "" ||
  !/<[a-z!/]/i.test(value) ||
  editor.isDestroyed ||
  normalized(editor.getHTML()) === normalized(value);

const htmlOf = (editor: Editor) => (editor.isEmpty ? "" : editor.getHTML());

function ToolButton({
  label,
  active,
  className,
  ...rest
}: { label: string; active?: boolean } & Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "children"
>) {
  return (
    <Tooltip content={label}>
      <Button
        variant="ghost"
        size="sm"
        aria-label={label}
        aria-pressed={active}
        onMouseDown={(e) => e.preventDefault()}
        className={`size-7 px-0 ${active ? "bg-hover" : ""} ${className ?? ""}`}
        {...rest}
      />
    </Tooltip>
  );
}

function LinkButton({
  editor,
  disabled,
  active,
}: {
  editor: Editor;
  disabled: boolean;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState("");
  const [error, setError] = useState("");
  const errorId = useId();

  const apply = (url: string) => {
    const chain = editor.chain().focus().extendMarkRange("link");
    const done = url
      ? chain.setLink({ href: url }).run()
      : chain.unsetLink().run();
    if (!done) {
      setError("Enter an http, https or mailto URL.");
      return;
    }
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setHref(editor.getAttributes("link").href ?? "");
          setError("");
        }
        setOpen(next);
      }}
      label="Link"
      trigger={
        <ToolButton
          label="Link"
          active={active}
          disabled={disabled}
          icon={<LinkIcon size={15} strokeWidth={1.75} aria-hidden />}
        />
      }
    >
      <form
        noValidate
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          apply(href.trim());
        }}
      >
        <input
          aria-label="Link URL"
          type="url"
          value={href}
          placeholder="https://"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setHref(e.target.value);
            setError("");
          }}
          className="h-8 w-56 rounded-control border border-field-line bg-field px-2 text-sm text-text focus-visible:outline-2 focus-visible:outline-focus"
        />
        <Button type="submit" size="sm" variant="primary">
          Apply
        </Button>
        {error && (
          <p id={errorId} className="basis-full text-xs text-danger-text">
            {error}
          </p>
        )}
        {active && (
          <Button size="sm" onClick={() => apply("")}>
            Remove
          </Button>
        )}
      </form>
    </Popover>
  );
}

function useRovingFocus() {
  const ref = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLElement | null>(null);

  const buttons = () =>
    [...(ref.current?.querySelectorAll("button") ?? [])].filter(
      (b) => !b.disabled,
    );

  useLayoutEffect(() => {
    const all = buttons();
    const stop =
      current.current && all.includes(current.current as HTMLButtonElement)
        ? current.current
        : all[0];
    for (const b of ref.current?.querySelectorAll("button") ?? [])
      b.tabIndex = b === stop ? 0 : -1;
  });

  const onFocus = (e: React.FocusEvent) => {
    if (!(e.target instanceof HTMLButtonElement)) return;
    if (!ref.current?.contains(e.target)) return;
    current.current = e.target;
    for (const b of ref.current.querySelectorAll("button"))
      b.tabIndex = b === e.target ? 0 : -1;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const all = buttons();
    const at = all.indexOf(e.target as HTMLButtonElement);
    if (at < 0) return;
    const next = {
      ArrowRight: (at + 1) % all.length,
      ArrowLeft: (at - 1 + all.length) % all.length,
      Home: 0,
      End: all.length - 1,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    all[next]!.focus();
  };

  return { ref, onFocus, onKeyDown };
}

function Toolbar({
  editor,
  disabled,
  onHtml,
}: {
  editor: Editor;
  disabled: boolean;
  onHtml: () => void;
}) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      link: e.isActive("link"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const icon = (Icon: typeof Bold) => (
    <Icon size={15} strokeWidth={1.75} aria-hidden />
  );
  const run = () => editor.chain().focus();
  const roving = useRovingFocus();
  return (
    <div
      {...roving}
      role="toolbar"
      aria-label="Formatting"
      className="flex flex-wrap items-center gap-0.5 border-b border-field-line px-1.5 py-1"
    >
      <ToolButton
        label="Bold"
        active={s.bold}
        disabled={disabled}
        icon={icon(Bold)}
        onClick={() => run().toggleBold().run()}
      />
      <ToolButton
        label="Italic"
        active={s.italic}
        disabled={disabled}
        icon={icon(Italic)}
        onClick={() => run().toggleItalic().run()}
      />
      <ToolButton
        label="Strikethrough"
        active={s.strike}
        disabled={disabled}
        icon={icon(Strikethrough)}
        onClick={() => run().toggleStrike().run()}
      />
      <ToolButton
        label="Inline code"
        active={s.code}
        disabled={disabled}
        icon={icon(Code)}
        onClick={() => run().toggleCode().run()}
      />
      <ToolButton
        label="Heading 2"
        active={s.h2}
        disabled={disabled}
        icon={icon(Heading2)}
        onClick={() => run().toggleHeading({ level: 2 }).run()}
      />
      <ToolButton
        label="Heading 3"
        active={s.h3}
        disabled={disabled}
        icon={icon(Heading3)}
        onClick={() => run().toggleHeading({ level: 3 }).run()}
      />
      <ToolButton
        label="Bullet list"
        active={s.bullet}
        disabled={disabled}
        icon={icon(List)}
        onClick={() => run().toggleBulletList().run()}
      />
      <ToolButton
        label="Ordered list"
        active={s.ordered}
        disabled={disabled}
        icon={icon(ListOrdered)}
        onClick={() => run().toggleOrderedList().run()}
      />
      <ToolButton
        label="Blockquote"
        active={s.quote}
        disabled={disabled}
        icon={icon(Quote)}
        onClick={() => run().toggleBlockquote().run()}
      />
      <ToolButton
        label="Code block"
        active={s.codeBlock}
        disabled={disabled}
        icon={icon(Code2)}
        onClick={() => run().toggleCodeBlock().run()}
      />
      <LinkButton editor={editor} disabled={disabled} active={s.link} />
      <ToolButton
        label="Undo"
        disabled={disabled || !s.canUndo}
        icon={icon(Undo2)}
        onClick={() => run().undo().run()}
      />
      <ToolButton
        label="Redo"
        disabled={disabled || !s.canRedo}
        icon={icon(Redo2)}
        onClick={() => run().redo().run()}
      />
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onHtml}>
        HTML
      </Button>
    </div>
  );
}

export default function RichTextEditor({
  name,
  value,
  error,
  disabled,
  onChange,
}: EditorInputProps) {
  const ids = useFieldIds({ error });
  const [html, setHtml] = useState(false);
  const [lossy, setLossy] = useState(false);
  const last = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false },
        trailingNode: false,
      }),
    ],
    content: value,
    editable: !disabled,
    editorProps: {
      attributes: {
        id: ids.id,
        role: "textbox",
        "aria-label": name,
        "aria-multiline": "true",
        class: "hb-rich",
      },
    },
    onUpdate: ({ editor: e }) => {
      last.current = htmlOf(e);
      onChangeRef.current(last.current);
    },
  });

  useLayoutEffect(() => {
    if (!survives(editor, value)) {
      setLossy(true);
      setHtml(true);
    }
  }, [editor]);

  useEffect(() => {
    if (value === last.current) return;
    last.current = value;
    editor.commands.setContent(value, { emitUpdate: false });
    const lost = !survives(editor, value);
    setLossy(lost);
    if (lost) setHtml(true);
  }, [editor, value]);

  useEffect(() => {
    editor.setEditable(!disabled, false);
  }, [editor, disabled]);

  if (html)
    return (
      <div className="flex flex-col gap-2">
        <CodeArea
          label={name}
          language="html"
          value={value}
          error={error}
          disabled={disabled}
          onChange={onChange}
        />
        {lossy && (
          <p className="text-xs text-muted">
            This content has elements the visual editor does not support; edit
            it as HTML. Switching to the visual editor may remove them.
          </p>
        )}
        <Button className="self-start" onClick={() => setHtml(false)}>
          Rich text
        </Button>
      </div>
    );

  return (
    <FieldShell {...ids} label={name} error={error}>
      <div
        className={`rounded-control border bg-field focus-within:outline-2 focus-within:outline-focus ${error ? "border-danger" : "border-field-line"} ${disabled ? "opacity-50" : ""}`}
      >
        <Toolbar
          editor={editor}
          disabled={disabled}
          onHtml={() => setHtml(true)}
        />
        <EditorContent editor={editor} />
      </div>
    </FieldShell>
  );
}
