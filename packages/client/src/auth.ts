import { toExpand, type Expand } from "@heybe/query";
import type { AuthRecord } from "./auth-store.js";
import type { HeybeClient } from "./client.js";
import { tokenPayload } from "./jwt.js";
import type { Rec } from "./records.js";
import type { AutoRefresh } from "./refresh.js";
import { hasAuthorization, type RequestOptions } from "./send.js";

export interface AuthResponse<T> {
  token: string;
  record: Rec<T>;
  meta?: Record<string, unknown>;
}

export interface OAuth2Provider {
  name: string;
  displayName: string;
  state: string;
  authURL: string;
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

export interface AuthMethods {
  password: { enabled: boolean; identityFields: string[] };
  oauth2: { enabled: boolean; providers: OAuth2Provider[] };
  mfa: { enabled: boolean; duration: number };
  otp: { enabled: boolean; duration: number };
}

export interface AuthOptions extends RequestOptions {
  mfaId?: string;
  expand?: Expand<unknown>;
  autoRefreshThreshold?: number;
}

export interface AuthClient<T> {
  methods(opts?: RequestOptions): Promise<AuthMethods>;
  withPassword(
    identity: string,
    password: string,
    opts?: AuthOptions,
  ): Promise<AuthResponse<T>>;
  requestOTP(email: string, opts?: RequestOptions): Promise<{ otpId: string }>;
  withOTP(
    otpId: string,
    password: string,
    opts?: AuthOptions,
  ): Promise<AuthResponse<T>>;
  withOAuth2Code(
    provider: string,
    code: string,
    codeVerifier: string,
    redirectURL: string,
    createData?: Partial<T>,
    opts?: AuthOptions,
  ): Promise<AuthResponse<T>>;
  refresh(opts?: AuthOptions): Promise<AuthResponse<T>>;
  impersonate(
    recordId: string,
    duration: number,
    opts?: RequestOptions,
  ): Promise<HeybeClient>;
  requestVerification(email: string, opts?: RequestOptions): Promise<void>;
  confirmVerification(token: string, opts?: RequestOptions): Promise<void>;
  requestPasswordReset(email: string, opts?: RequestOptions): Promise<void>;
  confirmPasswordReset(
    token: string,
    password: string,
    passwordConfirm: string,
    opts?: RequestOptions,
  ): Promise<void>;
  requestEmailChange(newEmail: string, opts?: RequestOptions): Promise<void>;
  confirmEmailChange(
    token: string,
    password: string,
    opts?: RequestOptions,
  ): Promise<void>;
}

export interface AuthDeps {
  autoRefresh: AutoRefresh;
  fork(): HeybeClient;
}

const SUPERUSERS = ["_superusers", "pbc_3142635823"];

export function createAuth<T>(
  client: HeybeClient,
  collection: string,
  deps: AuthDeps,
): AuthClient<T> {
  const base = `/api/collections/${encodeURIComponent(collection)}`;
  const store = client.authStore;

  const post = async (path: string, body: unknown, opts?: RequestOptions) => {
    await client.send(base + path, { ...opts, method: "POST", body });
  };

  async function authenticate(
    path: string,
    body: Record<string, unknown> | undefined,
    opts: AuthOptions = {},
  ): Promise<AuthResponse<T>> {
    const { mfaId, expand, autoRefreshThreshold, ...req } = opts;
    const expanded = toExpand(expand);
    const data = await client.send<AuthResponse<T>>(base + path, {
      ...req,
      method: "POST",
      body: mfaId ? { ...body, mfaId } : body,
      query: expanded ? { expand: expanded } : undefined,
    });
    store.save(data.token, data.record as unknown as AuthRecord);
    return data;
  }

  async function withPassword(
    identity: string,
    password: string,
    opts: AuthOptions = {},
    relogin = false,
  ): Promise<AuthResponse<T>> {
    const superuser = SUPERUSERS.includes(collection);
    if (superuser && !relogin) deps.autoRefresh.reset();
    const data = await authenticate(
      "/auth-with-password",
      { identity, password },
      opts,
    );
    const { autoRefreshThreshold, expand } = opts;
    if (autoRefreshThreshold !== undefined && superuser)
      deps.autoRefresh.register({
        threshold: autoRefreshThreshold,
        record: store.record!,
        run: () =>
          withPassword(
            identity,
            password,
            { autoRefreshThreshold, expand },
            true,
          ),
      });
    return data;
  }

  const sameRecord = (token: string) => {
    const payload = tokenPayload(token);
    const record = store.record;
    return (
      !!record &&
      record.id === payload.id &&
      record.collectionId === payload.collectionId
    );
  };

  return {
    methods(opts) {
      return client.send(base + "/auth-methods", {
        ...opts,
        query: { fields: "mfa,otp,password,oauth2" },
      });
    },
    withPassword: (identity, password, opts) =>
      withPassword(identity, password, opts),
    requestOTP(email, opts) {
      return client.send(base + "/request-otp", {
        ...opts,
        method: "POST",
        body: { email },
      });
    },
    withOTP(otpId, password, opts) {
      return authenticate("/auth-with-otp", { otpId, password }, opts);
    },
    withOAuth2Code(
      provider,
      code,
      codeVerifier,
      redirectURL,
      createData,
      opts,
    ) {
      return authenticate(
        "/auth-with-oauth2",
        { provider, code, codeVerifier, redirectURL, createData },
        opts,
      );
    },
    refresh(opts) {
      return authenticate("/auth-refresh", undefined, opts);
    },
    async impersonate(recordId, duration, opts) {
      const fork = deps.fork();
      const data = await fork.send<AuthResponse<T>>(
        `${base}/impersonate/${encodeURIComponent(recordId)}`,
        {
          ...opts,
          method: "POST",
          body: { duration },
          headers:
            store.token && !hasAuthorization(opts?.headers)
              ? { ...opts?.headers, Authorization: store.token }
              : opts?.headers,
        },
      );
      fork.authStore.save(data.token, data.record as unknown as AuthRecord);
      return fork;
    },
    requestVerification: (email, opts) =>
      post("/request-verification", { email }, opts),
    async confirmVerification(token, opts) {
      await post("/confirm-verification", { token }, opts);
      if (sameRecord(token) && !store.record!.verified)
        store.save(store.token, { ...store.record!, verified: true });
    },
    requestPasswordReset: (email, opts) =>
      post("/request-password-reset", { email }, opts),
    confirmPasswordReset: (token, password, passwordConfirm, opts) =>
      post(
        "/confirm-password-reset",
        { token, password, passwordConfirm },
        opts,
      ),
    requestEmailChange: (newEmail, opts) =>
      post("/request-email-change", { newEmail }, opts),
    async confirmEmailChange(token, password, opts) {
      await post("/confirm-email-change", { token, password }, opts);
      if (sameRecord(token)) store.clear();
    },
  };
}
