import { runeLength } from "../../fields/shared";
import {
  RealtimeConnectRequestEvent,
  RealtimeMessageEvent,
  RealtimeSubscribeRequestEvent,
} from "../../hooks/events";
import {
  AUTH_KEY,
  IP_KEY,
  clientAuth,
  isSameAuth,
} from "../../realtime/broadcast";
import { Client, type Message } from "../../realtime/broker";
import { ApiError, logUnexpected } from "../errors";
import { skipSuccessActivityLog } from "../middlewares";
import type { RequestEvent, Router } from "../router";

// Port of PB apis/realtime.go routes.

const IDLE_TIMEOUT = 5 * 60_000;
const MAX_TIMEOUT = 30 * 60_000;

const encoder = new TextEncoder();

export const sseFrame = (id: string, m: Message): string =>
  `id:${id}\nevent:${m.name}\ndata:${m.data}\n\n`;

async function realtimeConnect(e: RequestEvent): Promise<void> {
  e.responseHeaders.set("content-type", "text/event-stream");
  e.responseHeaders.set("cache-control", "no-store");
  e.responseHeaders.set("x-accel-buffering", "no");

  // PB cancelRequest: ends the loop below through the client
  let closed = false;
  let active: Client | null = null;
  const close = () => {
    closed = true;
    active?.discard();
  };
  if (e.req.signal.aborted) close();
  else e.req.signal.addEventListener("abort", close, { once: true });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => void (controller = c),
    cancel: close,
  });

  const client = new Client();
  client.set(IP_KEY, e.realIp());
  const event = RealtimeConnectRequestEvent.from(e, {
    client,
    idleTimeout: IDLE_TIMEOUT,
    maxTimeout: MAX_TIMEOUT,
  });

  let opened!: () => void;
  const open = new Promise<void>((resolve) => (opened = resolve));
  const done = e.app.hooks.onRealtimeConnectRequest.trigger(
    event,
    async (ce) => {
      const { app, client } = ce;
      const send = (message: Message) =>
        app.hooks.onRealtimeMessageSend.trigger(
          RealtimeMessageEvent.from(ce, { client, message }),
          (me) =>
            controller.enqueue(
              encoder.encode(sseFrame(me.client.id, me.message)),
            ),
        );
      app.realtime.register(client);
      active = client;
      if (closed) client.discard();
      const timers = app.timers;
      let maxTimer: unknown;
      let idleTimer: unknown;
      try {
        ce.stream(200, "text/event-stream", body);
        opened();
        try {
          const data = `{"clientId":"${client.id}"}`;
          // PB_CONNECT first, for apps that come from PocketBase with its SDK
          await send({ name: "PB_CONNECT", data });
          await send({ name: "HB_CONNECT", data });
        } catch {
          return;
        }
        maxTimer = timers.setTimeout(close, ce.maxTimeout);
        idleTimer = timers.setTimeout(close, ce.idleTimeout);
        for (;;) {
          const message = await client.receive();
          if (!message) return;
          try {
            await send(message);
          } catch {
            return;
          }
          timers.clearTimeout(idleTimer);
          idleTimer = timers.setTimeout(close, ce.idleTimeout);
        }
      } finally {
        timers.clearTimeout(maxTimer);
        timers.clearTimeout(idleTimer);
        app.realtime.unregister(client.id);
        try {
          controller.close();
        } catch {}
      }
    },
  );
  let streaming = false;
  void done.catch((err) => {
    if (streaming) logUnexpected(err);
  });
  await Promise.race([open.then(() => (streaming = true)), done]);
}

async function subscribeForm(
  e: RequestEvent,
): Promise<{ clientId: string; subscriptions: string[] }> {
  let body: Record<string, unknown>;
  try {
    body = await e.body();
  } catch (err) {
    if (err instanceof ApiError && err.status === 413) throw err;
    throw new ApiError(400, "");
  }
  const json = (e.req.headers.get("content-type") ?? "").startsWith(
    "application/json",
  );
  const { clientId = "", subscriptions = [] } = body;
  const list =
    json || Array.isArray(subscriptions) ? subscriptions : [subscriptions];
  if (
    (clientId !== null && typeof clientId !== "string") ||
    (list !== null &&
      (!Array.isArray(list) || list.some((s) => typeof s !== "string")))
  )
    throw new ApiError(400, "");
  return {
    clientId: clientId ?? "",
    subscriptions: (list as string[] | null) ?? [],
  };
}

const tooLong = (max: number) => ({
  code: "validation_length_too_long",
  message: `The length must be no more than ${max}.`,
  params: { max, min: 0 },
});

function validateForm(form: { clientId: string; subscriptions: string[] }) {
  const errors: Record<string, unknown> = {};
  const idLength = runeLength(form.clientId);
  if (idLength === 0)
    errors.clientId = {
      code: "validation_required",
      message: "Cannot be blank.",
    };
  else if (idLength > 255)
    errors.clientId = {
      code: "validation_length_out_of_range",
      message: "The length must be between 1 and 255.",
      params: { max: 255, min: 1 },
    };
  if (form.subscriptions.length > 1000) errors.subscriptions = tooLong(1000);
  else {
    const each: Record<string, unknown> = {};
    form.subscriptions.forEach((s, i) => {
      if (runeLength(s) > 2500) each[i] = tooLong(2500);
    });
    if (Object.keys(each).length > 0) errors.subscriptions = each;
  }
  if (Object.keys(errors).length > 0) throw new ApiError(400, "", errors);
}

async function realtimeSetSubscriptions(e: RequestEvent): Promise<void> {
  const form = await subscribeForm(e);
  validateForm(form);
  const client = e.app.realtime.clientById(form.clientId);
  if (!client) throw new ApiError(404, "Missing or invalid client id.");
  const ip = client.get(IP_KEY);
  if (typeof ip === "string" && ip !== "" && ip !== e.realIp())
    throw new ApiError(400, "Invalid realtime client.");
  const auth = clientAuth(client);
  if (auth && !isSameAuth(auth, e.auth))
    throw new ApiError(
      403,
      "The current and the previous request authorization don't match.",
    );
  const event = RealtimeSubscribeRequestEvent.from(e, {
    client,
    subscriptions: form.subscriptions,
  });
  await e.app.hooks.onRealtimeSubscribeRequest.trigger(event, (se) => {
    se.client.set(AUTH_KEY, se.auth);
    se.client.unsubscribe();
    se.client.subscribe(...se.subscriptions);
    se.noContent(204);
  });
}

export function registerRealtimeRoutes(router: Router): void {
  router.route(
    "GET",
    "/api/realtime",
    realtimeConnect,
    skipSuccessActivityLog(),
  );
  router.route("POST", "/api/realtime", realtimeSetSubscriptions);
}
