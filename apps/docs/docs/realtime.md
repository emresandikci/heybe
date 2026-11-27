# Realtime

Realtime uses server-sent events (SSE). A client opens one stream at `/api/realtime`, receives a client id, then tells the server which topics to subscribe to.

## With the client

```ts
const unsubscribe = await heybe
  .records("posts")
  .subscribe("*", ({ action, record }) => {}, {
    where: { status: "published" },
    expand: { author: true },
  });
await heybe.records("posts").subscribe("RECORD_ID", (e) => {});

await unsubscribe();
await heybe.records("posts").unsubscribe("RECORD_ID");
await heybe.records("posts").unsubscribe(); // every topic of the collection
```

- `"*"` subscribes to the whole collection, a record id to one record.
- `action` is `create`, `update` or `delete`.
- `where` and `expand` apply per subscription.
- A client only receives events for records its auth may read under the collection's rules (see [Collections and rules](/collections-and-rules)).

The client reads the stream with `fetch`, so it works in browsers, Bun and Node without `EventSource`. The first subscription opens the connection and the last unsubscribe closes it.

### Connection events

```ts
await heybe.realtime.subscribe("HB_CONNECT", ({ clientId }) => {});
heybe.realtime.onDisconnect = (activeTopics) => {};
```

### Reconnecting

A lost connection reconnects after 200, 300, 500, 1000, 1200, 1500, then every 2000 ms, and every topic is subscribed again. When the auth record changes (a login as another record or `clear()`), an open connection reconnects so events follow the new auth. A refreshed token for the same record keeps the connection and sends the subscriptions again.

## Without the client

1. `GET /api/realtime` opens the stream. The server sends `HB_CONNECT` first, with `{"clientId": "..."}`. It also sends `PB_CONNECT` with the same data, so clients written for PocketBase keep working. The client above listens for `HB_CONNECT`.
2. `POST /api/realtime` with `{"clientId": "...", "subscriptions": ["posts/*", "posts/RECORD_ID"]}` sets the topics.

Each event has the topic as its name and `{"record": {...}, "action": "create"}` as data.

## Limits

The server closes a stream after 5 minutes without a message and after 30 minutes in total. The client reconnects on its own. If you use SSE directly, reconnect and subscribe again.
