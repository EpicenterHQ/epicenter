# The Factory Function Pattern

When you need to build on top of an external client or resource, reach for a factory function. This is one of the most common and useful patterns for maintaining clean separation of concerns.

## The Scenario

You're using a client from an external library. A database connection, HTTP client, or API wrapper. You want to create functionality that depends on this client. Your first instinct might be to write a function like this:

```typescript
function doSomething(client, options) {
	// use client to do something
}

const client = createClient();
doSomething(client, { timeout: 5000, retries: 3 });
```

This works, but it has a subtle problem: the function takes the client as its first argument. Every call requires passing the client. And if you need configuration that persists across calls, you end up mixing concerns.

## The Problem Gets Worse

What happens when you need some configuration at "setup time" vs "call time"?

```typescript
// Bad: mixing setup options with call options
function doSomething(
	client,
	{
		// Setup-time config (should be set once)
		baseUrl,
		defaultTimeout,
		// Call-time options (different each call)
		endpoint,
		payload,
	},
) {
	// ...
}
```

Or worse, you might pipe client configuration through your function:

```typescript
// Worse: piping client config through your function
function doSomething(clientOptions, methodOptions) {
	const client = createClient(clientOptions); // Why create client inside?
	// ...
}
```

Now `doSomething` has to know about `createClient`'s options. When the client library adds new options, your function signature changes too. The concerns are tangled.

## The Pattern: Factory Functions

Instead of a function that takes a client, create a **factory function** that:

1. Takes the dependency (or dependencies) as the first argument
2. Takes configuration options as the optional second argument
3. Returns an object with methods

**This signature is universal.** Every factory function you write should follow it:

```typescript
function createSomething(dependencies, options?) {
	return {
		/* methods */
	};
}
```

The first argument is always resources. The second is always configuration. No exceptions.

```typescript
function createService(client, options = {}) {
	const { baseUrl, defaultTimeout } = options;

	return {
		doSomething(methodOptions) {
			const { endpoint, payload } = methodOptions;
			// Uses client, baseUrl, defaultTimeout, endpoint, payload
		},

		doSomethingElse(otherOptions) {
			// Can also use client, baseUrl, defaultTimeout
		},
	};
}
```

Usage:

```typescript
const client = createClient(clientOptions); // Client config stays here
const service = createService(client, {
	baseUrl: '/api',
	defaultTimeout: 5000,
});
service.doSomething({ endpoint: '/users', payload: data });
```

## Why This Works

Each layer is configured at the right level:

| Layer   | Configured At                           | Contains                                     |
| ------- | --------------------------------------- | -------------------------------------------- |
| Client  | `createClient(clientOptions)`           | Connection details, auth, low-level settings |
| Service | `createService(client, serviceOptions)` | Domain-specific setup, defaults, base URLs   |
| Method  | `service.doSomething(methodOptions)`    | Per-call parameters                          |

Client configuration no longer pipes through your code. When the client library changes, only the `createClient` call changes. Your service factory doesn't need to know.

## The Mental Model

Think of it as a chain:

```
External Library          Your Code                    Your Code
     ↓                       ↓                            ↓
createClient(...)  →  createService(client, ...)  →  service.method(...)
     ↑                       ↑                            ↑
 clientOptions          serviceOptions              methodOptions
```

Each link in the chain:

- Receives a resource from the previous link
- Adds its own configuration
- Produces something for the next link

## Real Examples

**Database + Repository:**

```typescript
const db = createDbConnection({ host: 'localhost', port: 5432 });
const users = createUserRepository(db, { tableName: 'users' });
users.findById(userId);
```

**HTTP Client + API Service:**

```typescript
const http = createHttpClient({ baseUrl: 'https://api.example.com' });
const payments = createPaymentService(http, { apiVersion: 'v2' });
payments.charge({ amount: 1000, currency: 'usd' });
```

**Epicenter Client + Server:**

```typescript
const client = createClient(workspaces, { projectDir });
const server = createServer(client, { cors: true });
server.start({ port: 3913 });
```

## The Key Insight

**Client configuration belongs at client creation time.**

Don't pipe `clientOptions` through your factory. Don't accept `{ ...clientOptions, ...serviceOptions }` as a merged blob. Let the caller create the client with whatever options they need, then hand you the fully-configured client.

This is the perfect level of inversion of control: your factory doesn't need to know how the client was configured. It just needs a working client.

## When to Use This Pattern

Use a factory function when:

- You're building on top of an external client/resource
- You need configuration that persists across multiple method calls
- You want to expose multiple related methods
- You want to enable testing by accepting a mock client

## Multiple Dependencies

Sometimes your service needs more than one client. In this case, accept a destructured object of dependencies as the first argument:

```typescript
function createAnalyticsService(
	{ db, cache, http }, // Multiple dependencies as first argument
	options = {}, // Service options as second argument
) {
	const { batchSize, flushInterval } = options;

	return {
		trackEvent(event) {
			// Uses db, cache, http, batchSize, flushInterval
		},

		getMetrics(query) {
			// Can use all dependencies
		},
	};
}
```

Usage:

```typescript
const db = createDbConnection(dbOptions);
const cache = createCacheClient(cacheOptions);
const http = createHttpClient(httpOptions);

const analytics = createAnalyticsService(
	{ db, cache, http },
	{ batchSize: 100, flushInterval: 5000 },
);

analytics.trackEvent({ name: 'page_view', page: '/home' });
```

The same principle applies: each client is configured at its own creation time. Your service factory just receives fully-configured dependencies.

## Related Patterns

- [The Universal Factory Function Signature](./universal-factory-signature.md): why every factory uses this signature
- [Stop Passing Clients as Arguments](./stop-passing-clients-as-arguments.md): practical guide
- [Factory Method Patterns](./factory-method-patterns.md): separating bundled options and method patterns
- [Factory function composition reference](../../.agents/skills/typescript/references/factory-function-composition.md): quick reference
