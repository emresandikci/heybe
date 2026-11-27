import { Badge } from "@heybejs/ui";
import { levelName } from "./level";

const tone = {
  INFO: "success",
  WARN: "warning",
  ERROR: "danger",
} as const;

export function LevelBadge({ level }: { level: number }) {
  const name = levelName(level);
  return (
    <Badge tone={tone[name as keyof typeof tone] ?? "neutral"}>{name}</Badge>
  );
}
