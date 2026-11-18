# Stateful factory examples

Read this when several pieces of instance state and repeated work appear to
represent a separate responsibility. For dependency arguments, configuration,
and returned methods, use [factory function composition](factory-function-composition.md).

## Extract a responsibility when it makes callers clearer

Several variables changing together can reveal one concept. It does not by
itself require another object. Look at the operations that read, change, and
reset them, and what the caller would gain from naming that work.

For example, a reconnect loop can accumulate a retry count, a pending wait,
and repeated delay and wake-up code. A backoff instance can own that work.
The parent can then wait, interrupt the wait when conditions change, and reset
the delay after a successful connection.

## A backoff with one pending wait

This example's caller awaits each sleep before starting the next. `wake`
finishes the current wait, and `reset` changes the delay of the next sleep.
The backoff keeps the retry count and wake-up function private:

```typescript
function createBackoff({ baseMs = 500, maxMs = 30_000 } = {}) {
	let retries = 0;
	let wakeSleep: (() => void) | undefined;

	return {
		async sleep() {
			const delay = Math.min(baseMs * 2 ** retries, maxMs);
			retries += 1;
			await new Promise<void>((resolve) => {
				const finish = () => {
					clearTimeout(timer);
					wakeSleep = undefined;
					resolve();
				};
				const timer = setTimeout(finish, delay);
				wakeSleep = finish;
			});
		},
		wake() {
			wakeSleep?.();
		},
		reset() {
			retries = 0;
		},
	};
}

const backoff = createBackoff({ baseMs: 0 });
await backoff.sleep();
backoff.reset();

const waiting = backoff.sleep();
backoff.wake();
await waiting;
```

The parent's operations now call `backoff.sleep()`, `backoff.wake()`, and
`backoff.reset()`. The name and operations explain the repeated work. There
is no need to expose the retry count or wake-up callback to callers.

## Keep control flow with the operation that owns it

A supervisor's desired state, run identity, and in-flight connection can be
closely related while still belonging in the supervisor. Extracting them can
force the parent to coordinate more calls without removing a decision.

Judge the complete caller after extraction. Keep the new boundary when it
names a responsibility, owns a lifetime, or removes repeated work. Keep state
local when it is needed to understand the operation's control flow.
