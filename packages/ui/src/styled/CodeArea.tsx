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
  placeholder as placeholderExtension,
} from "@codemirror/view";
import {
  autocompletion,
  closeCompletion,
  completionKeymap,
  type CompletionContext,
  type CompletionSource,
} from "@codemirror/autocomplete";
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
import { SQLite, schemaCompletionSource, sql } from "@codemirror/lang-sql";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { useFieldIds, type FieldProps } from "./field.js";
import { FieldShell } from "./FieldShell.js";

type Language = "json" | "sql" | "html" | "javascript";

export interface CodeSuggestion {
  from: number;
  options: { label: string; detail?: string; type?: string }[];
}

export type CodeSuggest = (text: string, pos: number) => CodeSuggestion | null;

interface CodeAreaProps extends FieldProps {
  value: string;
  onChange?: (value: string) => void;
  hideLabel?: boolean;
  rows?: number;
  disabled?: boolean;
  onRun?: () => void;
  singleLine?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  language?: Language;
  completions?: string[];
  suggest?: CodeSuggest;
  sqlSchema?: Record<string, string[]>;
}

export interface CodeAreaHandle {
  insert(text: string): void;
  focus(): void;
}

// lang-sql does not tokenize a leading "_", so "_su" would complete to "__superusers".
const withLeadingUnderscores =
  (source: CompletionSource): CompletionSource =>
  async (context) => {
    const result = await source(context);
    if (!result) return result;
    let from = result.from;
    while (from > 0 && context.state.sliceDoc(from - 1, from) === "_") from--;
    return { ...result, from };
  };

const sqlExtension = (schema?: Record<string, string[]>): Extension => {
  const support = sql({ dialect: SQLite });
  return [
    support,
    support.language.data.of({
      autocomplete: withLeadingUnderscores(
        schemaCompletionSource({ dialect: SQLite, schema }),
      ),
    }),
  ];
};

const languageExtension = (
  language?: Language,
  sqlSchema?: Record<string, string[]>,
): Extension => {
  if (language === "sql") return sqlExtension(sqlSchema);
  if (language === "json") return json();
  if (language === "html") return html();
  if (language === "javascript") return javascript();
  return [];
};

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
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--hb-font-mono)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--cm-comment)",
    border: "none",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-selectionBackground": { backgroundColor: "var(--hb-accent-soft)" },
  ".cm-tooltip": {
    backgroundColor: "var(--hb-surface-raised)",
    color: "var(--hb-text)",
    border: "1px solid var(--hb-line-strong)",
    borderRadius: "var(--hb-radius)",
    boxShadow: "var(--hb-shadow-overlay)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--hb-font-mono)",
    padding: "4px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    borderRadius: "var(--hb-radius-control)",
    padding: "3px 8px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--hb-accent)",
    color: "var(--hb-accent-fg)",
  },
  ".cm-placeholder": { color: "var(--hb-text-faint)" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "600" },
});

const external = Annotation.define<boolean>();

const lineHeightRem = 1.25;

export const CodeArea = forwardRef<CodeAreaHandle, CodeAreaProps>(
  function CodeArea(
    {
      label,
      value,
      onChange,
      hideLabel,
      error,
      hint,
      rows = 6,
      disabled,
      onRun,
      singleLine,
      readOnly,
      placeholder,
      language,
      completions,
      suggest,
      sqlSchema,
    },
    ref,
  ) {
    const ids = useFieldIds({ error, hint });
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const latest = useRef({ onChange, onRun, completions, suggest });
    latest.current = { onChange, onRun, completions, suggest };
    const schemaKey = JSON.stringify(sqlSchema);
    const compartments = useRef({
      language: new Compartment(),
      editable: new Compartment(),
      attributes: new Compartment(),
      height: new Compartment(),
    });

    const editable = (off?: boolean, locked?: boolean) => [
      EditorView.editable.of(!off),
      EditorState.readOnly.of(!!off || !!locked),
    ];
    const attributes = () =>
      EditorView.contentAttributes.of(
        Object.fromEntries(
          Object.entries({ ...ids.aria, "aria-label": label }).filter(
            ([, v]) => v !== undefined,
          ),
        ) as Record<string, string>,
      );
    const suggested = (context: CompletionContext, suggest: CodeSuggest) => {
      const result = suggest(context.state.doc.toString(), context.pos);
      if (!result) return null;
      const before = context.state.sliceDoc(
        Math.max(0, context.pos - 1),
        context.pos,
      );
      const spaced = singleLine && (before === "" || before === " ");
      if (result.from === context.pos && !context.explicit && !spaced)
        return null;
      return { from: result.from, options: result.options };
    };
    const words = (context: CompletionContext) => {
      const suggest = latest.current.suggest;
      if (suggest) return suggested(context, suggest);
      const list = latest.current.completions;
      if (!list?.length) return null;
      const options = list.map((label) => ({ label, type: "variable" }));
      const word = context.matchBefore(/[\w@.]+/);
      if (word) return { from: word.from, options, validFor: /^[\w@.]*$/ };
      const operator = context.matchBefore(/[!=<>~?&|]+/);
      if (operator)
        return { from: operator.from, options, validFor: /^[!=<>~?&|]*$/ };
      const before = context.state.sliceDoc(
        Math.max(0, context.pos - 1),
        context.pos,
      );
      if (context.explicit || (singleLine && (before === "" || before === " ")))
        return { from: context.pos, options, validFor: /^[\w@.]*$/ };
      return null;
    };
    const height = () =>
      readOnly
        ? EditorView.theme({
            "&": { maxHeight: "16rem" },
            ".cm-scroller": { overflow: "auto" },
            ".cm-content": { padding: "8px 0" },
            ".cm-line": { padding: "0 12px" },
            ".cm-cursor": { display: "none" },
          })
        : singleLine
          ? EditorView.theme({
              ".cm-content": { padding: "7px 10px", minHeight: "0" },
              ".cm-line": { padding: "0" },
              ".cm-scroller": { overflowY: "hidden" },
            })
          : EditorView.theme({
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
            singleLine || readOnly ? [] : lineNumbers(),
            placeholder ? placeholderExtension(placeholder) : [],
            history(),
            drawSelection(),
            highlightActiveLine(),
            bracketMatching(),
            autocompletion({ icons: false }),
            EditorState.languageData.of(() => [{ autocomplete: words }]),
            syntaxHighlighting(highlight),
            singleLine
              ? EditorState.transactionFilter.of((tr) => {
                  if (tr.newDoc.lines === 1) return tr;
                  return [
                    {
                      changes: {
                        from: 0,
                        to: tr.startState.doc.length,
                        insert: tr.newDoc.toString().replaceAll("\n", " "),
                      },
                      selection: tr.newSelection,
                    },
                  ];
                })
              : readOnly
                ? []
                : EditorView.lineWrapping,
            theme,
            keymap.of([
              {
                key: "Mod-Enter",
                run: (v) => {
                  if (!latest.current.onRun) return false;
                  closeCompletion(v);
                  latest.current.onRun();
                  return true;
                },
              },
              ...completionKeymap,
              {
                key: "Enter",
                run: (v) => {
                  if (!singleLine) return false;
                  // the suggestion list would cover the run's error message
                  closeCompletion(v);
                  latest.current.onRun?.();
                  return true;
                },
              },
              indentWithTab,
              ...defaultKeymap,
              ...historyKeymap,
            ]),
            c.language.of(languageExtension(language, sqlSchema)),
            c.editable.of(editable(disabled, readOnly)),
            c.attributes.of(attributes()),
            c.height.of(height()),
            EditorView.updateListener.of((u) => {
              if (
                u.docChanged &&
                !u.transactions.some((t) => t.annotation(external))
              )
                latest.current.onChange?.(u.state.doc.toString());
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
          c.language.reconfigure(languageExtension(language, sqlSchema)),
          c.editable.reconfigure(editable(disabled, readOnly)),
          c.attributes.reconfigure(attributes()),
          c.height.reconfigure(height()),
        ],
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      language,
      schemaKey,
      disabled,
      readOnly,
      rows,
      singleLine,
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
      <FieldShell
        {...ids}
        label={label}
        hideLabel={hideLabel}
        error={error}
        hint={hint}
      >
        <div
          ref={host}
          className={`w-full rounded-control border border-field-line bg-field focus-within:outline-2 focus-within:outline-focus ${disabled ? "opacity-60" : ""}`}
        />
      </FieldShell>
    );
  },
);
