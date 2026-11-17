# The Universal Factory Function Signature

Every factory function I write follows this signature:

```typescript
function createSomething(dependencies, options?) {
	return {
		/* methods */
	};
}
```

Two arguments. First is dependencies, second is configuration. That's it.

## The Signature

**First argument: Dependencies**

Either a single resource:

```typescript
function createUserService(db) {
	return {
		/* methods */
	};
}
```

Or multiple resources as a destructured object:

```typescript
function createUserService({ db, cache, logger }) {
	return {
		/* methods */
	};
}
```

**Second argument: Configuration (optional)**

Options specific to this factory. Not dependency configuration. That belongs at dependency creation time.

```typescript
function createUserService({ db, cache, logger }, options = {}) {
	const { defaultPageSize = 20, enableMetrics = false } = options;
	return {
		/* methods */
	};
}
```

## Why This Enables Composition

This signature makes your code composable because each factory:

1. **Receives fully-configured dependencies**: it doesn't know or care how they were configured
2. **Adds its own layer of configuration**: specific to its domain
3. **Returns something the next layer can use**: an object with methods

```typescript
// Layer 1: Create dependencies (each configured independently)
const db = createDbConnection({ host: 'localhost', pool: 10 });
const cache = createRedisClient({ host: 'redis', ttl: 3600 });
const logger = createLogger({ level: 'info', format: 'json' });

// Layer 2: Compose into services
const users = createUserService({ db, cache, logger }, { defaultPageSize: 50 });
const orders = createOrderService(
	{ db, cache, logger },
	{ enableAuditLog: true },
);

// Layer 3: Compose into higher-level constructs
const api = createApiServer({ users, orders }, { cors: true, rateLimit: 100 });
api.start({ port: 3000 });
```

Each layer receives what it needs, adds its own configuration, and produces something for the next layer. Nothing leaks across boundaries.

## The Wrong Alternatives

### Wrong: Passing dependencies on every call

```typescript
// Every call repeats the same dependencies
fetchUsers(db, cache, logger, { active: true });
fetchUsers(db, cache, logger, { role: 'admin' });
fetchUsers(db, cache, logger, { department: 'eng' });
```

Problems:

- Repetitive and noisy
- Adding a dependency changes every call site
- No place to put service-level configuration

### Wrong: Creating dependencies inside

```typescript
function createUserService(dbConfig, cacheConfig, loggerConfig, options) {
	const db = createDbConnection(dbConfig); // Created inside!
	const cache = createRedisClient(cacheConfig); // Created inside!
	const logger = createLogger(loggerConfig); // Created inside!
	return {
		/* methods */
	};
}
```

Problems:

- Can't share dependencies across services
- Can't inject mocks for testing
- Function signature explodes with dependency configs
- Violates single responsibility

### Wrong: Mixed options blob

```typescript
function createUserService({
	// Dependency config (shouldn't be here)
	dbHost,
	dbPool,
	cacheHost,
	cacheTtl,
	logLevel,
	// Actual service options
	defaultPageSize,
	enableMetrics,
}) {
	const db = createDbConnection({ host: dbHost, pool: dbPool });
	// ...
}
```

Problems:

- Impossible to tell what's dependency config vs service config
- Changes to dependency libraries ripple through your code
- Testing requires knowing all the internals

### Wrong: Too many positional arguments

```typescript
function createUserService(db, cache, logger, emailClient, metrics, options) {
  // ...
}

// At the call site: what's the third argument again?
const users = createUserService(db, cache, logger, email, metrics, { ... });
```

Problems:

- Easy to get argument order wrong
- Adding a dependency changes the signature
- Not self-documenting

## The Right Way

```typescript
function createUserService({ db, cache, logger }, options = {}) {
	const { defaultPageSize = 20, enableMetrics = false } = options;

	return {
		async findById(id) {
			const cached = await cache.get(`user:${id}`);
			if (cached) return cached;

			const user = await db.query('SELECT * FROM users WHERE id = ?', [id]);
			await cache.set(`user:${id}`, user);
			return user;
		},

		async list(filters) {
			logger.info('Listing users', { filters });
			// Uses defaultPageSize from options
			// ...
		},
	};
}
```

Usage:

```typescript
const db = createDbConnection(dbConfig);
const cache = createRedisClient(cacheConfig);
const logger = createLogger(logConfig);

const users = createUserService({ db, cache, logger }, { defaultPageSize: 50 });

users.findById(123);
users.list({ active: true });
```

## When to Use This Pattern

Use the factory function signature when:

- **You're wrapping external dependencies**: database clients, HTTP clients, SDKs
- **You need configuration that persists**: settings that apply across all method calls
- **You want testability**: inject mocks at creation time
- **You're building composable systems**: services that depend on other services

Don't overthink it for:

- **Pure utility functions**: `formatDate(date)` doesn't need a factory
- **One-off scripts**: if you're not reusing it, keep it simple
- **Trivial wrappers**: if there's no configuration and one method, a plain function might be fine

## The Rule

When in doubt, follow this rule:

> If your function takes a client/resource as its first argument, it should probably be a factory function instead.

Write `createService(client)` that returns `{ method() }`, not `doSomething(client, options)`.

## Related

- [Stop Passing Clients as Arguments](./stop-passing-clients-as-arguments.md): the problem this solves
- [The Factory Function Pattern](./factory-function-pattern.md): detailed walkthrough
- [Factory Method Patterns](./factory-method-patterns.md): separating bundled options
- [Factory function composition reference](../../.agents/skills/typescript/references/factory-function-composition.md): quick reference
