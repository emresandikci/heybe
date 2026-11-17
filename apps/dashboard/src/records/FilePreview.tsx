import { Dialog } from "@heybe/ui";

export function FilePreview({
  name,
  url,
  onClose,
}: {
  name: string;
  url: string;
  onClose: () => void;
}) {
  return (
    <Dialog open title={name} onClose={onClose}>
      <img src={url} alt={name} className="mx-auto max-h-[70vh]" />
    </Dialog>
  );
}
