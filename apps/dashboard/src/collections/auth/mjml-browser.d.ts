declare module "mjml-browser" {
  interface MjmlError {
    line: number;
    message: string;
    tagName: string;
  }
  export default function mjml2html(
    source: string,
    options?: {
      validationLevel?: "strict" | "soft" | "skip";
      fonts?: Record<string, string>;
    },
  ): Promise<{ html: string; errors: MjmlError[] }>;
}
