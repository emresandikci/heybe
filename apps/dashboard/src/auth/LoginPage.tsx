import { HeybeError } from "@heybe/client";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { useClient } from "../app/context";
import { ErrorScope, UnclaimedErrors, errorMessage } from "../app/errors";
import { Button } from "../ui/Button";
import { AuthCard, Field } from "./AuthCard";
import { safeRedirect } from "./session";

const EMAIL = /^[^@\s]+@[^@\s]+$/;

export function LoginPage() {
  const client = useClient();
  const navigate = useNavigate();
  const search = useSearch({ from: "/login" });
  const auth = client.auth("_superusers");
  const methods = useQuery({
    queryKey: ["superuserAuthMethods"],
    queryFn: ({ signal }) => auth.methods({ signal }),
  });
  const [identity, setIdentity] = useState("");
  const [password, setPassword] = useState("");
  const [otpEmail, setOtpEmail] = useState("");
  const [otpPassword, setOtpPassword] = useState("");
  const [mfaId, setMfaId] = useState("");
  const [otpId, setOtpId] = useState("");
  const [lastOtpId, setLastOtpId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const done = () => navigate({ href: safeRedirect(search.redirect) });

  const requestOTP = async (email: string) => {
    try {
      const result = await auth.requestOTP(email);
      setOtpId(result.otpId);
      setLastOtpId(result.otpId);
    } catch (err) {
      if (err instanceof HeybeError && err.status === 429) setOtpId(lastOtpId);
      throw err;
    }
  };

  const signInWithPassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      try {
        await auth.withPassword(identity, password);
      } catch (err) {
        const id = err instanceof HeybeError && err.response.mfaId;
        if (err instanceof HeybeError && err.status === 401 && id) {
          setMfaId(String(id));
          if (EMAIL.test(identity)) {
            setOtpEmail(identity);
            await requestOTP(identity);
          }
          return;
        }
        throw err;
      }
      await done();
    });
  };

  const sendCode = (e: FormEvent) => {
    e.preventDefault();
    void run(() => requestOTP(otpEmail));
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await auth.withOTP(otpId, otpPassword, mfaId ? { mfaId } : {});
      await done();
    });
  };

  let body: ReactNode;
  if (methods.isPending) body = <p>Loading...</p>;
  else if (methods.isError)
    body = <p role="alert">{errorMessage(methods.error)}</p>;
  else if (methods.data.password.enabled && !mfaId)
    body = (
      <form
        key="password"
        onSubmit={signInWithPassword}
        className="flex flex-col gap-3"
      >
        <Field
          path="identity"
          label="Email"
          type="email"
          autoFocus
          autoComplete="username"
          required
          value={identity}
          onChange={(e) => setIdentity(e.target.value)}
        />
        <Field
          path="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <UnclaimedErrors />
        <Button type="submit" variant="primary" loading={busy}>
          Sign in
        </Button>
        <Link to="/request-password-reset" className="text-sm underline">
          Forgot password?
        </Link>
      </form>
    );
  else if ((methods.data.otp.enabled || mfaId) && !otpId)
    body = (
      <form
        key="request-otp"
        onSubmit={sendCode}
        className="flex flex-col gap-3"
      >
        {mfaId && <p className="text-sm">Finish signing in with a code.</p>}
        <Field
          path="email"
          label="Email"
          type="email"
          autoFocus
          autoComplete="username"
          required
          value={otpEmail}
          onChange={(e) => setOtpEmail(e.target.value)}
        />
        <UnclaimedErrors />
        <Button type="submit" variant="primary" loading={busy}>
          Send code
        </Button>
      </form>
    );
  else if (otpId)
    body = (
      <form key="verify-otp" onSubmit={verify} className="flex flex-col gap-3">
        <p className="text-sm">Check {otpEmail} for the code.</p>
        <Field
          path="password"
          label="One-time password"
          autoFocus
          autoComplete="one-time-code"
          required
          value={otpPassword}
          onChange={(e) => setOtpPassword(e.target.value)}
        />
        <UnclaimedErrors />
        <Button type="submit" variant="primary" loading={busy}>
          Verify
        </Button>
        <Button variant="ghost" onClick={() => setOtpId("")}>
          Send a new code
        </Button>
      </form>
    );
  else body = <p>No sign-in method is enabled for superusers.</p>;

  return (
    <AuthCard title="Superuser sign in">
      <ErrorScope error={error}>{body}</ErrorScope>
    </AuthCard>
  );
}
