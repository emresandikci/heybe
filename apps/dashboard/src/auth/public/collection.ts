import { tokenPayload } from "@heybejs/client";

export function collectionIdOf(token: string): string | null {
  const id = tokenPayload(token).collectionId;
  return typeof id === "string" && id ? id : null;
}
