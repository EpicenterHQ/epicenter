# From Dependency Injection to Factory Methods

Two patterns for cleaning up resource management and making APIs more natural to use.

**Related**: [The Factory Function Pattern](./factory-function-pattern.md): a deep dive into why and how to create factory functions that wrap external clients.

## Pattern 1: Invert Control for Resource Dependencies

When a factory function internally creates its own dependencies, callers lose control over those dependencies.

### The Problem

```typescript
// createServer internally does this:
//   1. Creates a client from workspaces + projectDir via `createClient(workspaces, { projectDir: '...' })`
//   2. Creates the HTTP app using that client
//   3. Returns both

const { app, client } = await createServer(workspaces, { projectDir: '...' });
app.listen(3913);
```

The function signature mixes concerns: `workspaces` and `projectDir` are client configuration, but `createServer` shouldn't care about client creation. It just needs a working client.

This coupling creates problems:

- Can't reuse an existing client across server and CLI
- Can't inject a mock client for testing
- Can't configure client and server independently
- Function signature grows whenever client options change

### The Solution

```typescript
// Caller controls client creation
const client = await createClient(workspaces, { projectDir: '...' });

// Server only receives what it actually needs
const app = createServer(client);
app.listen(3913);
```

Now `createServer` has a single responsibility: wrap a client in an HTTP interface. The caller decides how and when to create the client.

### Why This Matters

With the client externalized, you can:

```typescript
// Share one client between server and CLI
const client = await createClient(workspaces, { projectDir });
const app = createServer(client);
const cli = createCLI(client);

// Inject a mock for testing
const mockClient = createMockClient();
const app = createServer(mockClient);

// Configure client independently
const client = await createClient(workspaces, {
	projectDir,
	// other client-specific options
});
```

## Pattern 2: When First Argument is a Resource, Make it a Method

If a function's first argument is always a specific resource returned by a factory, that function should be a method on the returned object instead.

### Evolution of an API

This pattern often emerges through iteration. Here's how a CLI API might evolve through three stages:

**Stage 1: Everything bundled together**

```typescript
// runCLI internally does ALL of this:
//   1. Calls createClient(workspaces, { projectDir }) to create a client
//   2. Calls createCLI(client) to create a CLI instance
//   3. Parses argv and executes the appropriate command
//   4. Returns the result

await runCLI(workspaces, { projectDir }, argv);
```

The function hides three distinct operations behind one call. You can't share clients between CLI and server, can't inject mocks for testing, and can't configure the client independently. This is the same problem from Pattern 1.

**Stage 2: Separate creation, but awkward calling convention**

```typescript
// Client creation is now external (good!)
const client = await createClient(workspaces, { projectDir });
const cli = createCLI(client);

// But we still pass cli to a separate function (awkward)
await runCLI(cli, argv);
```

Better; client creation is now external, so you can share clients and inject mocks. But `runCLI(cli, ...)` is awkward. The `cli` object exists, yet we pass it to a separate function. If `cli` is always required, why isn't `run` just a method on it?

**Stage 3: Method on the object**

```typescript
const client = await createClient(workspaces, { projectDir });
const cli = createCLI(client);
await cli.run(argv);
```

Now the relationship is clear: `cli` is an object with capabilities, and `run` is one of them.

### Another Example: Server Start

Before:

```typescript
const client = createClient();
startServer(client, { port: 3913 });
```

After:

```typescript
const client = createClient();
const server = createServer(client);
server.start({ port: 3913 });
```

### Why Methods Win

In general, seeing any resource as the first argument of a function and that function NOT being a factory is a code smell.

1. **Discoverability**: Type `server.` and autocomplete shows all available operations
2. **No import hunting**: You don't need to find and import `startServer` separately
3. **Clear ownership**: The method lives where it belongs; on the object it operates on
4. **Encapsulation**: Internal state stays internal; the method accesses what it needs

## The General Rule

When you see a resource as the first argument of a function that isn't a factory, it's usually a sign that concerns are bundled at the wrong level.

### Before and After

The most common case: you create a client, then call a function that takes the client as its first argument.

**Before:**

```typescript
const client = createClient();
doSomething(client, options);
```

**After:**

```typescript
const client = createClient();
const service = createService(client);
service.doSomething(options);
```

---

Worse is when client creation is hidden inside the function:

**Before:**

```typescript
// Internally creates client, then does something with it
doSomething(clientOptions, methodOptions);
```

**After:**

```typescript
const client = createClient(clientOptions);
const service = createService(client);
service.doSomething(methodOptions);
```

---

Even worse is when client options get mixed with other options in one blob:

**Before:**

```typescript
// All options merged together: what belongs where?
doSomething({
	// Client config (shouldn't be here!)
	timeout: 5000,
	retries: 3,
	// Method options
	endpoint: '/users',
	payload: data,
});

// Inside doSomething, this mess happens:
function doSomething(options) {
	const { timeout, retries, ...methodOptions } = options;
	const client = createClient({ timeout, retries }); // Client created inside!
	const service = createService(client); // Service created inside!
	return service.fetch(methodOptions); // Finally the actual work
}
```

**After:**

```typescript
// Each layer configured at the right level
const client = createClient({ timeout: 5000, retries: 3 });
const service = createService(client);
service.doSomething({ endpoint: '/users', payload: data });
```

---

Worst is when multiple layers of creation are hidden inside:

**Before:**

```typescript
// Internally creates client AND service, then calls method
doSomething(clientOptions, serviceOptions, methodOptions);

// Or with merged options (even harder to untangle):
doSomething(clientOptions, { ...serviceOptions, ...methodOptions });
```

**After:**

```typescript
const client = createClient(clientOptions);
const service = createService(client, serviceOptions);
service.doSomething(methodOptions);
```

---

The more options bundled together, the harder it becomes to test, reuse, or configure each layer independently. Separating them gives you control at each step.

### More Examples

Here are a few more variations to help you recognize the pattern:

```typescript
// When the service needs options but the client doesn't
const client = createClient();
const service = createService(client, serviceOptions);
service.doSomething(methodOptions);
```

```typescript
// When neither client nor service need options
const client = createClient();
const service = createService(client);
service.doSomething(methodOptions);
```

```typescript
// Real example: database + user service
const db = createDbConnection(connectionString);
const users = createUserService(db);
users.findById(userId);
```

### Why This Structure?

The client is typically a general-purpose, low-level resource: a database connection, HTTP client, or API client. It comes from an external library or a different part of your codebase.

The service is a domain-specific object that wraps the client and exposes focused methods. This is exactly what `createServer(client)` and `createCLI(client)` do: they take a general-purpose client and expose domain-specific methods like `server.start()` and `cli.run()`.

**The key insight: client configuration belongs at client creation time.**

Don't pipe `clientOptions` through your service factory. Don't accept `{ ...clientOptions, ...serviceOptions }` as a merged blob. Let the caller create the client with whatever options they need, then hand you the fully-configured client. Your factory doesn't need to know how the client was configured. It just needs a working client.

This is the perfect level of inversion of control. For more on this pattern, see [The Factory Function Pattern](./factory-function-pattern.md).

## The Factory Function Signature

Every factory function follows the same signature:

```typescript
function createService(dependencies, options?) {
	return {
		/* methods */
	};
}
```

**First argument**: The resource or resources. Either a single client:

```typescript
function createUserService(db, options?) { ... }
```

Or a destructured object when multiple dependencies are needed:

```typescript
function createAnalyticsService({ db, cache, http }, options?) { ... }
```

**Second argument (optional)**: Configuration options specific to this factory. Not client options. Those belong at client creation time.

This signature is consistent across all factory functions. Once you internalize it, the pattern becomes second nature.

## Summary

The two patterns work together: Pattern 1 ensures your factory receives explicit dependencies (not creating them internally), and Pattern 2 ensures operations on the result are methods rather than separate functions.

## Resources

- [The Universal Factory Function Signature](./universal-factory-signature.md): the signature explained in depth
- [The Factory Function Pattern](./factory-function-pattern.md): deep dive into factory functions
- [Stop Passing Clients as Arguments](./stop-passing-clients-as-arguments.md): practical guide
- [Factory function composition reference](../../.agents/skills/typescript/references/factory-function-composition.md): quick reference
