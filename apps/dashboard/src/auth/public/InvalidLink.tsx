import { AuthCard } from "../AuthCard";

export function InvalidLink({ title }: { title: string }) {
  return (
    <AuthCard title={title}>
      <p role="alert">Invalid or expired link.</p>
    </AuthCard>
  );
}
