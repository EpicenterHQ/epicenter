# Stop Passing Clients as Arguments

You're using a database client, or an HTTP client, or some SDK from a third-party library. You need to write a function that uses it. Your first instinct:

```typescript
function fetchUsers(db, filters) {
	return db.query('SELECT * FROM users WHERE ...', filters);
}

const db = createDbConnection(connectionString);
fetchUsers(db, { active: true });
```

This works. But you've created a pattern that will haunt you.

## The Problem Compounds

A few weeks later, you need caching:

```typescript
function fetchUsers(db, cache, filters) {
	const cached = cache.get('users', filters);
	if (cached) return cached;
	const users = db.query('SELECT * FROM users WHERE ...', filters);
	cache.set('users', filters, users);
	return users;
}
```

Then you need logging:

```typescript
function fetchUsers(db, cache, logger, filters) {
	logger.info('Fetching users', { filters });
	// ...
}
```

Every call site now looks like this:

```typescript
fetchUsers(db, cache, logger, { active: true });
fetchUsers(db, cache, logger, { role: 'admin' });
fetchUsers(db, cache, logger, { department: 'engineering' });
```

You're passing the same three arguments over and over. And if you add a fourth dependency? You update every call site.

## The Worse Version

Sometimes you see this:

```typescript
function fetchUsers(dbConfig, filters) {
	const db = createDbConnection(dbConfig); // Created inside!
	return db.query('SELECT * FROM users WHERE ...', filters);
}
```

Now the function creates its own database connection. You can't share connections. You can't inject a mock for testing. You can't even see what dependencies exist without reading the implementation.

Or this monstrosity:

```typescript
function fetchUsers({
	host, // db config
	port, // db config
	connectionPool, // db config
	cacheHost, // cache config
	cacheTtl, // cache config
	active, // actual filter
	role, // actual filter
}) {
	// Good luck figuring out what's what
}
```

Configuration from three different concerns, all mashed into one options blob.

## The Fix: Factory Functions

Stop writing functions that take clients. Write factory functions that _return_ objects with methods:

```typescript
function createUserService(db) {
	return {
		fetch(filters) {
			return db.query('SELECT * FROM users WHERE ...', filters);
		},

		findById(id) {
			return db.query('SELECT * FROM users WHERE id = ?', [id]);
		},
	};
}
```

Usage:

```typescript
const db = createDbConnection(connectionString);
const users = createUserService(db);

users.fetch({ active: true });
users.findById(123);
```

Need caching and logging? Your factory takes multiple dependencies:

```typescript
function createUserService({ db, cache, logger }) {
	return {
		fetch(filters) {
			logger.info('Fetching users', { filters });
			const cached = cache.get('users', filters);
			if (cached) return cached;
			// ...
		},
	};
}
```

Usage:

```typescript
const db = createDbConnection(dbConfig);
const cache = createCacheClient(cacheConfig);
const logger = createLogger(logConfig);

const users = createUserService({ db, cache, logger });

users.fetch({ active: true }); // Clean!
users.fetch({ role: 'admin' }); // No repeated dependencies!
```

## The Universal Signature

Every factory function follows this signature:

```typescript
function createSomething(dependencies, options?) {
	return {
		/* methods */
	};
}
```

**First argument**: Dependencies. Either a single client or a destructured object of multiple clients.

**Second argument**: Optional configuration for _this_ factory. Not client config. That belongs at client creation time.

That's it. Two arguments max. First is resources, second is config.

## Why This Works

1. **Dependencies are passed once** at creation time, not on every call
2. **Each client is configured where it's created**: no piping config through your code
3. **Testing is trivial**: inject mocks at factory creation
4. **Adding dependencies doesn't change call sites**: only the factory creation
5. **Autocomplete works**: type `users.` and see all available methods

## The Mental Model

Think of it as a chain:

```
createClient(clientConfig)
    ↓
createService(client, serviceConfig)
    ↓
service.method(methodArgs)
```

Each link receives a resource from the previous link, optionally adds its own configuration, and produces something for the next link.

Client configuration stays at client creation. Service configuration stays at service creation. Method arguments stay at method calls. Nothing bleeds across layers.

## Before You Write Your Next Function

Ask yourself: "Am I about to write a function where the first argument is always a client?"

If yes, write a factory function instead. Return an object with methods. Accept dependencies at creation time.

Your future self will thank you.

## Real-World Example: Database Stores

Here's a concrete example from our [YJS vs SQLite benchmark](./yjs-storage-efficiency/README.md). The benchmark compares storage performance, but notice how cleanly the code reads:

```typescript
// Factory creates the store, closing over the database
function createSqliteStore(path: string) {
	const db = new Database(path);

	// Setup happens once at creation
	db.exec(`CREATE TABLE IF NOT EXISTS records (...)`);
	const insertStmt = db.prepare(`INSERT INTO records VALUES (...)`);

	return {
		insertAll(records) {
			const tx = db.transaction(() => {
				for (const r of records) insertStmt.run(r);
			});
			tx();
		},

		deleteAll() {
			db.exec('DELETE FROM records');
		},

		readAll() {
			return db.query('SELECT * FROM records').all();
		},

		close() {
			db.close();
		},
	};
}
```

Usage is clean:

```typescript
const sqlite = createSqliteStore('./data.db');

sqlite.insertAll(records); // No db argument!
sqlite.deleteAll(); // Clean API
const all = sqlite.readAll(); // Methods know their database

sqlite.close();
```

The same pattern works for YJS:

```typescript
function createYjsStore() {
	const doc = new Y.Doc();
	const recordsMap = doc.getMap('records');

	return {
		insertAll(records) {
			doc.transact(() => {
				for (const r of records) {
					recordsMap.set(r.id, r);
				}
			});
		},

		deleteAll() {
			doc.transact(() => {
				for (const key of recordsMap.keys()) {
					recordsMap.delete(key);
				}
			});
		},

		readAll() {
			return Array.from(recordsMap.values());
		},
	};
}
```

Both stores have the same interface. The implementation details are hidden. Testing is trivial. Just call the methods.

## Further Reading

- [The Universal Factory Function Signature](./universal-factory-signature.md): why every factory uses this signature
- [The Factory Function Pattern](./factory-function-pattern.md): the full pattern with all variations
- [Factory Method Patterns](./factory-method-patterns.md): separating bundled options and turning functions into methods
- [Factory function composition reference](../../.agents/skills/typescript/references/factory-function-composition.md): quick reference
