import { HeybeError } from "@heybe/client";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useClient } from "../app/context";
import { ErrorScope, UnclaimedErrors, errorMessage } from "../app/errors";
import { Button } from "@heybe/ui";
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
  const [mfaId, setMfaId] = useState("");
  const [otpId, setOtpId] = useState("");
  const [lastOtpId, setLastOtpId] = useState("");
  const [error, setError] = useState<unknown>(null);

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

  const signInWithPassword = async ({
    identity,
    password,
  }: {
    identity: string;
    password: string;
  }) => {
    try {
      await auth.withPassword(identity, password);
    } catch (err) {
      const id = err instanceof HeybeError && err.response.mfaId;
      if (err instanceof HeybeError && err.status === 401 && id) {
        setMfaId(String(id));
        if (EMAIL.test(identity)) {
          form.setFieldValue("otpEmail", identity);
          await requestOTP(identity);
        }
        return;
      }
      throw err;
    }
    await done();
  };

  const form = useForm({
    defaultValues: {
      identity: "",
      password: "",
      otpEmail: "",
      otpPassword: "",
    },
    onSubmitMeta: { step: "password" } as {
      step: "password" | "sendCode" | "verify";
    },
    onSubmit: async ({ value, meta }) => {
      setError(null);
      try {
        if (meta.step === "password") await signInWithPassword(value);
        else if (meta.step === "sendCode") await requestOTP(value.otpEmail);
        else {
          await auth.withOTP(otpId, value.otpPassword, mfaId ? { mfaId } : {});
          await done();
        }
      } catch (err) {
        setError(err);
      }
    },
  });

  let body: ReactNode;
  if (methods.isPending) body = <p>Loading...</p>;
  else if (methods.isError)
    body = <p role="alert">{errorMessage(methods.error)}</p>;
  else if (methods.data.password.enabled && !mfaId)
    body = (
      <form
        key="password"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit({ step: "password" });
        }}
        className="flex flex-col gap-3"
      >
        <form.Field name="identity">
          {(field) => (
            <Field
              path="identity"
              label="Email"
              type="email"
              autoFocus
              autoComplete="username"
              required
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          )}
        </form.Field>
        <form.Field name="password">
          {(field) => (
            <Field
              path="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          )}
        </form.Field>
        <UnclaimedErrors />
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" variant="primary" loading={isSubmitting}>
              Sign in
            </Button>
          )}
        </form.Subscribe>
        <Link to="/request-password-reset" className="text-sm underline">
          Forgot password?
        </Link>
      </form>
    );
  else if ((methods.data.otp.enabled || mfaId) && !otpId)
    body = (
      <form
        key="request-otp"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit({ step: "sendCode" });
        }}
        className="flex flex-col gap-3"
      >
        {mfaId && <p className="text-sm">Finish signing in with a code.</p>}
        <form.Field name="otpEmail">
          {(field) => (
            <Field
              path="email"
              label="Email"
              type="email"
              autoFocus
              autoComplete="username"
              required
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          )}
        </form.Field>
        <UnclaimedErrors />
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" variant="primary" loading={isSubmitting}>
              Send code
            </Button>
          )}
        </form.Subscribe>
      </form>
    );
  else if (otpId)
    body = (
      <form
        key="verify-otp"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit({ step: "verify" });
        }}
        className="flex flex-col gap-3"
      >
        <form.Subscribe selector={(s) => s.values.otpEmail}>
          {(otpEmail) => (
            <p className="text-sm">Check {otpEmail} for the code.</p>
          )}
        </form.Subscribe>
        <form.Field name="otpPassword">
          {(field) => (
            <Field
              path="password"
              label="One-time password"
              autoFocus
              autoComplete="one-time-code"
              required
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          )}
        </form.Field>
        <UnclaimedErrors />
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" variant="primary" loading={isSubmitting}>
              Verify
            </Button>
          )}
        </form.Subscribe>
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
