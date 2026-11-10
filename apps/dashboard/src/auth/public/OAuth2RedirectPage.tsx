import { useEffect } from "react";
import { AuthCard } from "../AuthCard";

export function OAuth2RedirectPage({ success }: { success: boolean }) {
  useEffect(() => {
    window.close();
  }, []);

  return (
    <AuthCard title="Sign in">
      <p role={success ? "status" : "alert"}>
        {success
          ? "Sign-in completed. You can close this window."
          : "Sign-in failed. Close this window and try again."}
      </p>
    </AuthCard>
  );
}
