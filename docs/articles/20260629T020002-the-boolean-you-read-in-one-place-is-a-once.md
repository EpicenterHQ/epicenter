# The Boolean You Read In One Place Is a `once`

When a boolean flag is read in exactly one place, the body it guards, it isn't state. It's a `once` wrapper written by hand. The `let flag = false`, the `if (flag) return`, and the `flag = true` exist only to make that body run at most once, and `once(fn)` already does exactly that.

Here's the one that started the sweep: an iroh bi-stream adapter that has to release its connection exactly once, whether the read half hits EOF or the write half closes first.

```ts
function biStreamToByteChannel(bi, onClose) {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    onClose?.();
  };
  return {
    source: recvToReadable(bi.recv, fire),
    sink: sendToWritable(bi.send, fire),
  };
}
```

`fire` goes to both halves; either one can call it, and only the first call should reach `onClose`. That is the whole job of `fired`. So the whole thing is:

```ts
function biStreamToByteChannel(bi, onClose) {
  const fire = once(() => onClose?.());
  return {
    source: recvToReadable(bi.recv, fire),
    sink: sendToWritable(bi.send, fire),
  };
}
```

`once(fn)` runs `fn` on the first call, caches the result, and returns that same result on every later call. The flag, the guard, and the assignment all fold into the wrapper, and what's left is the line you actually cared about.

## The Test

Grep the flag's name and count the reads.

If the only thing that reads the flag is the one body it guards, it's a `once`. The flag was bookkeeping for "have I run yet," and `once` already keeps that book.

If other methods read the flag to decide whether they're allowed to run, it is not a `once`. It's a liveness flag, and it stays a boolean.

That one grep sorted five conversions from three refusals in the same sweep.

## The Conversions

The same shape turned up across the daemon and the gateway. A lease that rolls back its SQLite transaction once:

```ts
// before
release(): void {
  if (released) return;
  released = true;
  bestEffortSync(() => { if (db?.inTransaction) db.run('ROLLBACK'); });
  bestEffortSync(() => db?.close());
}
// after
release: once((): void => {
  bestEffortSync(() => { if (db?.inTransaction) db.run('ROLLBACK'); });
  bestEffortSync(() => db?.close());
}),
```

A gateway accept loop that should only start once:

```ts
// before
listen() {
  if (listening) return;
  listening = true;
  void (async () => { for (;;) { /* acceptNext, handle, repeat */ } })();
}
// after
listen: once(() => {
  void (async () => { for (;;) { /* acceptNext, handle, repeat */ } })();
}),
```

And an MCP transport whose `onclose` must fire exactly once, whether the remote half ends, the source errors, or we close locally:

```ts
// before
let closed = false;
const fireClose = () => {
  if (closed) return;
  closed = true;
  transport.onclose?.();
};
// after
const fireClose = once(() => transport.onclose?.());
```

The async close is the one conversion with a real behavior change, and the change is an improvement. The old `close()` returned `undefined` immediately on a second call. Wrapped in `once`, a second `close()` returns the same promise as the first, so a concurrent caller awaits the actual teardown instead of racing past it. Idempotent close got more honest, not just shorter.

## When It Is Not a `once`

Three flags in the same files stayed booleans, and the reason each one stayed is the real lesson.

`started` throws on reuse:

```ts
async start() {
  if (started) throw new Error('StreamTransport already started');
  started = true;
  // ...
}
```

That's an assertion, not an idempotent body. A second `start()` is a bug the code wants to surface. `once` would swallow it into a silent no-op, which is the opposite of what an assertion is for.

`disposed` is read by other methods:

```ts
if (disposed) return [];   // inside a query method
// ...
if (disposed) return;      // inside the dispose method
disposed = true;
```

The query method reads `disposed` to refuse work on a dead object. That makes it a liveness flag: it answers "am I still alive" for the whole object, not "have I torn down yet" for one body. `once` wraps a single function, so it can't be the thing three methods consult.

`settled` guards two entry points at once:

```ts
resolve(value) { if (settled) return; settled = true; resolve(value); },
reject(error)  { if (settled) return; settled = true; reject(error); },
```

First of resolve-or-reject wins. These are two functions sharing one latch with different bodies, and `once` wraps one function. There's no single body to hand it.

## The Two Faces of `once`

The version here returns `void` and exists for its side effect: fire the callback, release the connection, close the socket. The other common use returns a value and exists to memoize it: hydrate a list from disk once, lazy-import a Tauri module once, build a conflict index only when there's a conflict. Same helper, same "first call wins and the rest get the cached result," pointed at a value instead of an effect. If the body you're collapsing returns something a caller reads, you're in the memoization face; if it returns nothing and the point is "do this at most once," you're in the guard face this article is about.

Both faces share the same trap, by the way: `once` caches the result forever, including a thrown one. If the wrapped body can reject and a caller awaits the cached promise, every later caller awaits the same rejection. For a teardown that's usually fine. For a memoized read it means the body must not throw, or a single bad first call poisons every future one.

---

Related: [If You Always Set Them Together, They Are One Variable](./20260307T120000-if-you-always-set-them-together-they-are-one-variable.md) is the same collapse for coupled state. [Sync Dispose, Async Cleanup, Nobody Waits](./20260422T160000-sync-dispose-cascade.md) is the idempotent-teardown story one layer up.
