import { useToast } from "./Toasts.js";
import { Button } from "./Button.js";

export function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const toast = useToast();
  return (
    <Button
      variant="ghost"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success("Copied.");
        } catch {
          toast.error("Could not copy.");
        }
      }}
    >
      {label}
    </Button>
  );
}
