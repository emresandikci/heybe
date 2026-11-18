import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useFieldError } from "../../app/errors";
import { Button, CodeArea, useConfirm } from "@heybe/ui";
import { compileMjml, readSource, stripSource, withSource } from "./mjml";
import { mjmlStarter, type TemplateKind } from "./mjml-starters";
import type { EmailTemplate } from "../editor-state";
import type { OptCtx, OptPath } from "./opts";

export interface TemplateState {
  mode: "mjml" | "html";
  source: string;
  error: string | null;
  compiling: boolean;
}

// Kept by the collection editor so MJML sources and errors survive tab switches and can block saving.
export interface TemplateStore {
  states: Record<string, TemplateState>;
  put: (key: string, state: TemplateState) => void;
  ticket: (key: string) => number;
  latest: (key: string, ticket: number) => boolean;
}

const TemplateStoreContext = createContext<TemplateStore | null>(null);
export const TemplateStoreProvider = TemplateStoreContext.Provider;

export function useTemplateStore() {
  const [states, setStates] = useState<Record<string, TemplateState>>({});
  const tickets = useRef<Record<string, number>>({});
  const store: TemplateStore = {
    states,
    put: (key, state) => setStates((s) => ({ ...s, [key]: state })),
    ticket: (key) => (tickets.current[key] = (tickets.current[key] ?? 0) + 1),
    latest: (key, ticket) => tickets.current[key] === ticket,
  };
  const all = Object.values(states);
  return {
    store,
    invalid: all.some((s) => s.error),
    compiling: all.some((s) => s.compiling),
    reset: () => setStates({}),
  };
}

const PLACEHOLDERS =
  "Placeholders: {APP_NAME}, {APP_URL}, {TOKEN}, {OTP}, {OTP_ID}, {RECORD:<field>}, {ALERT_INFO}";

export function TemplateBody({
  c,
  path,
  label,
  kind,
  superuser,
  actions,
}: {
  c: OptCtx;
  path: OptPath<EmailTemplate>;
  label: string;
  kind: TemplateKind;
  superuser: boolean;
  actions?: ReactNode;
}) {
  const store = useContext(TemplateStoreContext)!;
  const confirm = useConfirm();
  const [preview, setPreview] = useState(false);
  const key = path;
  const bodyPath = `${path}.body` as const;
  const body = c.form.getFieldValue(path)?.body ?? "";
  const serverError = useFieldError(bodyPath);
  const saved = readSource(body);
  const startNew = saved === null && !c.draft.id;
  const state: TemplateState = store.states[key] ?? {
    mode: saved !== null || startNew ? "mjml" : "html",
    source: saved ?? (startNew ? mjmlStarter(kind, superuser) : ""),
    error: null,
    compiling: false,
  };

  const compile = async (source: string) => {
    const ticket = store.ticket(key);
    store.put(key, { mode: "mjml", source, error: null, compiling: true });
    const { html, errors } = await compileMjml(source);
    if (!store.latest(key, ticket)) return;
    const error = errors.length > 0 ? errors.join(" ") : null;
    store.put(key, { mode: "mjml", source, error, compiling: false });
    if (!error) c.form.setFieldValue(bodyPath, withSource(html, source));
  };

  useEffect(() => {
    if (startNew && !store.states[key]) void compile(state.source);
    // Runs once per mount: a new collection compiles its starter into the body.
  }, []);

  const convert = async () => {
    if (saved !== null) return void compile(saved);
    const ok = await confirm({
      title: "Convert to MJML",
      message: "The HTML body is replaced by the MJML starter for this email.",
      confirmLabel: "Convert",
    });
    if (ok) void compile(mjmlStarter(kind, superuser));
  };

  const editAsHtml = async () => {
    const ok = await confirm({
      title: "Edit as HTML",
      message:
        "The MJML source is dropped on your first HTML edit. Until then, Convert to MJML brings it back.",
      confirmLabel: "Edit as HTML",
    });
    if (ok) store.put(key, { ...state, mode: "html", error: null });
  };

  const html = stripSource(body);
  return (
    <>
      {state.mode === "mjml" ? (
        <CodeArea
          label="Body (MJML)"
          language="html"
          rows={12}
          value={state.source}
          error={serverError ?? state.error ?? undefined}
          hint={PLACEHOLDERS}
          onChange={(source) => void compile(source)}
        />
      ) : (
        <CodeArea
          label="Body (HTML)"
          language="html"
          rows={8}
          value={html}
          error={serverError}
          hint={PLACEHOLDERS}
          onChange={(value) => c.form.setFieldValue(bodyPath, value)}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {state.mode === "mjml" ? (
          <Button onClick={() => void editAsHtml()}>Edit as HTML</Button>
        ) : (
          <Button onClick={() => void convert()}>Convert to MJML</Button>
        )}
        <Button aria-expanded={preview} onClick={() => setPreview(!preview)}>
          {preview ? "Hide preview" : "Show preview"}
        </Button>
        {actions}
      </div>
      {preview && (
        <iframe
          sandbox=""
          title={`${label} preview`}
          srcDoc={html}
          className="h-72 w-full rounded border border-line-strong bg-surface"
        />
      )}
    </>
  );
}
