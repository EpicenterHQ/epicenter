# Rust's `?` Operator Is a Pipe in Disguise

Rust's `?` and functional programming's `pipe(andThen(...))` do the same thing: run a sequence of fallible operations, skip the rest if one fails, and propagate the error to the caller. The difference is syntax. Rust baked it into the language as a postfix operator. FP libraries rebuild it from function composition. TypeScript has neither, so we write it out by hand.

## Three operations, one character each

A Rust function that fetches a user, validates them, and loads their profile:

```rust
fn process_user(id: UserId) -> Result<Profile, DeviceError> {
    let user = get_user(id)?;
    let validated = validate(user)?;
    let profile = load_profile(validated)?;
    Ok(profile)
}
```

The happy path reads top to bottom. Each `?` says: if this returned `Err`, stop here and return that error from the whole function. Otherwise, unwrap the `Ok` and keep going. The `?` desugars to a match and early return:

```rust
let user = match get_user(id) {
    Ok(val) => val,
    Err(e) => return Err(e.into()),
};
```

That's all it does. Pattern match, early return. One character replaces five lines.

## The same thing, written as a pipe

The functional programming version of the same sequence:

```typescript
const profile = pipe(
  getUser(id),
  andThen(validate),
  andThen(loadProfile),
)
```

Each `andThen` unwraps `Ok` and passes the value forward. If any step returns `Err`, subsequent steps are skipped and the error falls through to the end. This is the same railroad: happy path on top, error path on the bottom.

The `?` operator is `andThen` with syntax sugar. Both encode the same control flow: unwrap or bail.

## Pipes break down when you need branching

The linear case is clean in both styles. The trouble starts when you need an `if` inside the pipeline. In Effect-TS, that looks like this:

```typescript
pipe(
  getUser(id),
  Effect.flatMap(user =>
    user.isAdmin
      ? pipe(
          getAdminDashboard(user),
          Effect.map(dashboard => ({ user, dashboard }))
        )
      : pipe(
          getUserDashboard(user),
          Effect.map(dashboard => ({ user, dashboard }))
        )
  ),
  Effect.flatMap(({ user, dashboard }) => renderPage(user, dashboard))
)
```

Three levels of `pipe` nesting. The `flatMap` with a ternary is an if-statement rewritten as a function call. You haven't eliminated branching; you've moved it from a language keyword into a library function. And because each step is a closure, `user` from the first step isn't in scope in the last step. You have to thread it through an object: `{ user, dashboard }`.

In Rust, the same branching is just an if-statement:

```rust
fn process_user(id: UserId) -> Result<Profile, DeviceError> {
    let user = get_user(id)?;
    let dashboard = if user.is_admin {
        get_admin_dashboard(&user)?
    } else {
        get_user_dashboard(&user)?
    };
    render_page(&user, &dashboard)?
}
```

`user` stays in scope. The if-statement is a regular if-statement. The `?` still handles the error path. No nesting, no context threading, no pipes inside pipes.

## TypeScript's closest equivalent: destructure and bail

TypeScript doesn't have `?`. It doesn't have do-notation or computation expressions either. The closest you get is writing out the desugaring by hand:

```typescript
const { data: user, error: userError } = await getUser(id);
if (userError) return Err(userError);

const { data: validated, error: validationError } = validate(user);
if (validationError) return Err(validationError);

const { data: profile, error: profileError } = await loadProfile(validated.id);
if (profileError) return Err(profileError);

return Ok(profile);
```

Each pair of lines is one `?`. Destructure the result, check for error, return early if present. The happy path reads top to bottom. Variables stay in scope naturally. Branching is just `if`.

The tradeoff compared to Rust is verbosity: two lines per operation instead of one character. The tradeoff compared to pipes is clarity: no nesting, no context threading, no library-level rewrites of `if` and `match`.

## The spectrum has three points

Pipe composition encodes control flow in data. Rust's `?` encodes it in a postfix operator. TypeScript's destructure-and-bail encodes it in explicit early returns. All three propagate typed errors through a sequence of fallible operations. The difference is how much the language helps you.

TypeScript helps the least. But the code is obvious to anyone who reads it, and that counts for more than saving a few lines.
