import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { json } from "@codemirror/lang-json";
import { sql } from "@codemirror/lang-sql";
import { html } from "@codemirror/lang-html";
import { useFieldIds, type FieldProps } from "./field";
import { FieldShell } from "./FieldShell";

type Language = "json" | "sql" | "html";

interface CodeAreaProps extends FieldProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  disabled?: boolean;
  onRun?: () => void;
  language?: Language;
}

export interface CodeAreaHandle {
  insert(text: string): void;
  focus(): void;
}

const languages: Record<Language, () => Extension> = { json, sql, html };

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: "var(--cm-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--cm-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--cm-number)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--cm-name)" },
  { tag: [tags.tagName, tags.typeName], color: "var(--cm-tag)" },
  { tag: [tags.comment, tags.meta], color: "var(--cm-comment)" },
  { tag: [tags.name, tags.variableName], color: "var(--cm-variable)" },
  {
    tag: [tags.function(tags.variableName), tags.standard(tags.name)],
    color: "var(--cm-function)",
  },
  {
    tag: [tags.operator, tags.compareOperator, tags.logicOperator],
    color: "var(--cm-operator)",
  },
  {
    tag: [tags.bracket, tags.punctuation, tags.angleBracket],
    color: "var(--cm-punctuation)",
  },
]);

const theme = EditorView.theme({
  "&": { fontSize: "0.875rem", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "2px solid var(--cm-focus)" },
  ".cm-scroller": { fontFamily: "var(--font-mono, monospace)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--cm-comment)",
    border: "none",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-selectionBackground": { backgroundColor: "var(--cm-selection)" },
});

const external = Annotation.define<boolean>();

const lineHeightRem = 1.25;

export const CodeArea = forwardRef<CodeAreaHandle, CodeAreaProps>(
  function CodeArea(
    {
      label,
      value,
      onChange,
      error,
      hint,
      rows = 6,
      disabled,
      onRun,
      language,
    },
    ref,
  ) {
    const ids = useFieldIds({ error, hint });
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const latest = useRef({ onChange, onRun });
    latest.current = { onChange, onRun };
    const compartments = useRef({
      language: new Compartment(),
      editable: new Compartment(),
      attributes: new Compartment(),
      height: new Compartment(),
    });

    const editable = (off?: boolean) => [
      EditorView.editable.of(!off),
      EditorState.readOnly.of(!!off),
    ];
    const attributes = () =>
      EditorView.contentAttributes.of(
        Object.fromEntries(
          Object.entries({ ...ids.aria, "aria-label": label }).filter(
            ([, v]) => v !== undefined,
          ),
        ) as Record<string, string>,
      );
    const height = () =>
      EditorView.theme({
        ".cm-content, .cm-gutter": {
          minHeight: `${rows * lineHeightRem}rem`,
        },
      });

    useLayoutEffect(() => {
      const c = compartments.current;
      const instance = new EditorView({
        parent: host.current!,
        state: EditorState.create({
          doc: value,
          extensions: [
            lineNumbers(),
            history(),
            drawSelection(),
            highlightActiveLine(),
            bracketMatching(),
            syntaxHighlighting(highlight),
            EditorView.lineWrapping,
            theme,
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  if (!latest.current.onRun) return false;
                  latest.current.onRun();
                  return true;
                },
              },
              indentWithTab,
              ...defaultKeymap,
              ...historyKeymap,
            ]),
            c.language.of(language ? languages[language]() : []),
            c.editable.of(editable(disabled)),
            c.attributes.of(attributes()),
            c.height.of(height()),
            EditorView.updateListener.of((u) => {
              if (
                u.docChanged &&
                !u.transactions.some((t) => t.annotation(external))
              )
                latest.current.onChange(u.state.doc.toString());
            }),
          ],
        }),
      });
      view.current = instance;
      return () => {
        instance.destroy();
        view.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useLayoutEffect(() => {
      const v = view.current;
      if (!v || v.state.doc.toString() === value) return;
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: value },
        annotations: external.of(true),
      });
    }, [value]);

    useLayoutEffect(() => {
      const c = compartments.current;
      view.current?.dispatch({
        effects: [
          c.language.reconfigure(language ? languages[language]() : []),
          c.editable.reconfigure(editable(disabled)),
          c.attributes.reconfigure(attributes()),
          c.height.reconfigure(height()),
        ],
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      language,
      disabled,
      rows,
      label,
      ids.aria["aria-invalid"],
      ids.aria["aria-describedby"],
    ]);

    useImperativeHandle(ref, () => ({
      insert(text) {
        const v = view.current;
        if (!v) return;
        v.dispatch(v.state.replaceSelection(text));
        v.focus();
      },
      focus: () => view.current?.focus(),
    }));

    return (
      <FieldShell {...ids} label={label} error={error} hint={hint}>
        <div
          ref={host}
          className={`w-full rounded border border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800 ${disabled ? "opacity-60" : ""}`}
        />
      </FieldShell>
    );
  },
);
