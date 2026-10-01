# When You Learn Pipes, Then Unlearn Them

Every developer who gets into functional programming discovers pipe composition and thinks: this is it. Chain pure functions together, errors flow through automatically, the happy path is all you see. Then you try to build something real with it and start writing if-statements as function calls. The journey from "pipes are beautiful" to "just destructure and check the error" is one most FP-curious TypeScript developers take eventually. Here's what that looks like.

## Stage 1: Everything is a pipeline

You learn about `pipe` and `andThen`. You write your first composition and it feels like magic:

```typescript
const profile = pipe(
  getUser(id),
  andThen(validate),
  andThen(loadProfile),
)
```

Three functions. No error handling visible. If `getUser` fails, `validate` and `loadProfile` are skipped automatically. The error propagates to the end. You've separated the happy path from the error path, and the code reads like a sentence.

This is Railroad Oriented Programming: two parallel tracks. The top track carries success values forward. The bottom track carries errors. Each `andThen` is a railroad switch: unwrap `Ok` and continue, or stay on the error track.

For linear sequences of fallible operations, this is genuinely elegant.

## Stage 2: Branching breaks the beauty

Then you need an if-statement inside the pipeline. Maybe the logic depends on a value from an earlier step. In Effect-TS, that means reaching for `Effect.if` or `Effect.flatMap` with a conditional return:

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

Pipes inside pipes. The `flatMap` with a ternary is an if-statement wearing a function call's clothes. `Effect.if({ onTrue: ..., onFalse: ... })` is the same thing, just more explicit about it.

Two things happened. First, you're no longer eliminating control flow; you're rewriting it. The branching is still there, just expressed through library functions instead of language keywords. Second, `user` from the first step isn't in scope in the last step, so you're threading it through `{ user, dashboard }` objects and destructuring at every boundary.

This is where the pipe dream starts to crack. You wanted to remove boilerplate, but the boilerplate just moved. Instead of `if (error) return`, you're writing `Effect.flatMap(x => condition ? pipe(...) : pipe(...))`.

## Stage 3: Rust does it without pipes

Then you look at Rust. No pipe operator. No `andThen` chains. Just this:

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

The `?` operator does what `andThen` does: unwrap `Ok` or return `Err` from the function. But it's a postfix character, not a higher-order function. Variables stay in scope. Branching is a regular if-statement. The happy path reads top to bottom, the error path is implicit in the return type, and the code looks like normal imperative code.

Rust got railroad programming without the railroad syntax. The `?` is `andThen` compiled into the language itself.

## Stage 4: Effect-TS generators try to split the difference

Effect-TS noticed the same problem with deeply nested pipes. Their answer: generators with `yield*`.

```typescript
const program = Effect.gen(function* () {
  const user = yield* getUser(id)
  const dashboard = user.isAdmin
    ? yield* getAdminDashboard(user)
    : yield* getUserDashboard(user)
  return yield* renderPage(user, dashboard)
})
```

This is closer to Rust than to pipes. Each `yield*` unwraps the Effect (like `?` unwraps Result). Variables stay in scope. Branching is a regular ternary. The generator acts as the "do-notation" that Haskell uses for the same purpose.

It works. But it wraps everything in `Effect.gen(function* () { ... })`, and every operation needs `yield*` instead of `?`. It's the right idea with more ceremony than Rust's version.

## Stage 5: TypeScript without the framework

Then you look at what wellcrafted does in plain TypeScript:

```typescript
const { data: user, error: userError } = await getUser(id);
if (userError) return Err(userError);

const { data: validated, error: validationError } = validate(user);
if (validationError) return Err(validationError);

const { data: profile, error: profileError } = await loadProfile(validated.id);
if (profileError) return Err(profileError);

return Ok(profile);
```

Two lines per operation instead of one character. No syntax sugar, no generators, no framework. But errors are in the type signature. The happy path reads top to bottom. Variables stay in scope. Branching is just `if`.

This is where the journey ends for TypeScript. Not because it's the most elegant, but because the language doesn't give you `?` or `yield*`-without-a-wrapper or do-notation. The destructure-and-bail pattern is the closest you get to Rust's `?` without importing a runtime.

## The pattern underneath all of them

Every stage is doing the same thing: running a sequence of operations that might fail, skipping the rest on failure, and propagating the error. Pipes encode that as function composition. Rust's `?` encodes it as a postfix operator. Effect's `yield*` encodes it as generator suspension. Wellcrafted's destructure-and-bail encodes it as explicit early returns.

The lesson isn't that pipes are bad. For linear chains of fallible operations, they're concise and clear. The lesson is that pipes are a specific encoding of a general pattern, and that encoding gets expensive when the language doesn't have native support for it. TypeScript doesn't. So the pragmatic choice is the one that reads like TypeScript: destructure, check, return.
