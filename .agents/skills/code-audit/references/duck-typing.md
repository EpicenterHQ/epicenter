# Duck typing

Read when auditing runtime shape checks, casts to locally invented object
shapes, or property access through `Record<string, unknown>`.

Hunt for code that guesses what an object contains. Look for opportunities
to replace those guesses with the contract that owns the value.

## Search the audited scope

Start with the package or directory under review:

```bash
audit_scope=packages/account/src
```

Find casts that let code inspect properties its existing type does not declare:

```bash
rg -n 'as\s+\{[^}]*\??:\s*unknown|as\s+Record<string,\s*unknown>' \
  "$audit_scope" --glob '*.ts' --glob '*.svelte'
```

Find shape checks that may appear without a cast:

```bash
rg -n "\btypeof\b|['\"][^'\"]+['\"]\s+in\s|Object\.hasOwn\(|\.hasOwnProperty\(" \
  "$audit_scope" --glob '*.ts' --glob '*.svelte'
```

These are search leads. Results include ordinary value validation,
type-level `typeof`, and test fixtures. Multiline casts and indirect
helpers can escape the patterns. Follow relevant calls and declarations.

Once a property or guard looks relevant, search for its producers and uses:

```bash
rg -n 'completeSignIn|isCallbackAuthClient' \
  packages/account/src apps/whispering/src
```

Substitute the names involved in the candidate being investigated.

## Follow the agreement

For each candidate:

- Trace where the value is created and which contract describes it.
- Identify what the consumer needs to know.
- Compare what the check establishes with what the following code assumes.
- Look for missing declarations, copied shapes, repeated checks, and
  fallbacks that hide a broken agreement.

When the contract is missing or inconsistent, repair it at its owner and
carry the change through consumers. Import or derive an existing type when
it already expresses the agreement. A cast alone does not validate input.

Keep runtime checks that recognize a supported capability or validate
input whose shape is not yet known. Establish why the check is sufficient
for its callers. A comment can explain that reasoning, but cannot replace it.

## Worked example: completing browser sign-in

The account package provides browser and desktop clients. Both support
starting sign-in. The browser client also completes sign-in when the
browser returns to a callback page. The desktop shell handles its own return.

The package declares that distinction in
[auth-contract.ts](../../../../packages/account/src/auth-contract.ts):
`CallbackAuthClient` extends `AuthClient` with `completeSignIn`.

The search finds this check inside `isCallbackAuthClient`:

```ts
typeof (client as { completeSignIn?: unknown }).completeSignIn ===
  'function'
```

Follow the implementations:

- [The browser client](../../../../packages/account/src/browser-oauth.ts)
  supplies `completeSignIn`.
- [The desktop client](../../../../packages/account/src/tauri.ts)
  does not supply it.
- [connectAccount](../../../../packages/account/src/connect.ts)
  selects the implementation for the current environment.

Then follow the consumer.
[Whispering’s callback page](../../../../apps/whispering/src/lib/components/SignInCallback.svelte)
checks the capability before calling it:

```ts
if (!isCallbackAuthClient(account)) return;
void account.completeSignIn().then(({ data, error }) => {
  // Handle the result.
});
```

Keep this guard. It distinguishes a supported capability whose contract
already belongs to the account package.

The check establishes that the method is callable. Its argument and return
contract comes from the typed implementations. Do not treat this guard as
validation of an arbitrary external object.

If another consumer independently guesses the same shape, investigate
whether it should use the existing contract and guard.

## Report the consequence

For a repair, identify the assumption, what it could break, and how the
proposed contract removes that uncertainty.

For a consequential decision to keep a check, explain the runtime
distinction it serves and the evidence supporting it.

A search match alone is not a finding. Do not manufacture a cleanup when
the existing contract and check already serve their callers.
