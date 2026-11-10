import { errorMessage } from "../../app/errors";

const MARKER = /\n?<!-- heybe:mjml:([A-Za-z0-9+/=]*) -->\s*$/;

function encode(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decode(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function withSource(html: string, source: string): string {
  return `${html}\n<!-- heybe:mjml:${encode(source)} -->`;
}

export function readSource(body: string): string | null {
  const match = MARKER.exec(body);
  if (!match) return null;
  try {
    return decode(match[1]!);
  } catch {
    return null;
  }
}

export function stripSource(body: string): string {
  return body.replace(MARKER, "");
}

// The server wraps the body in its own layout document, so keep the head styles and the body content only.
function bodyFragment(html: string): string {
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? "";
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  const styles = head
    .replace(/<title>[\s\S]*?<\/title>/gi, "")
    .replace(/<meta [^>]*>/gi, "");
  return `${styles.trim()}\n${body.trim()}`;
}

type Mjml = typeof import("mjml-browser").default;
const importMjml = () => import("mjml-browser").then((m) => m.default);
let loading: { load: () => Promise<Mjml>; promise: Promise<Mjml> } | null =
  null;

export async function compileMjml(
  source: string,
  load = importMjml,
): Promise<{ html: string; errors: string[] }> {
  if (loading?.load !== load) loading = { load, promise: load() };
  let mjml2html: Mjml;
  try {
    mjml2html = await loading.promise;
  } catch (err) {
    loading = null;
    return { html: "", errors: [errorMessage(err)] };
  }
  try {
    const result = await mjml2html(source, {
      validationLevel: "soft",
      fonts: {},
    });
    return {
      html: bodyFragment(result.html),
      errors: result.errors.map((e) => `Line ${e.line}: ${e.message}`),
    };
  } catch (err) {
    return { html: "", errors: [errorMessage(err)] };
  }
}
