# Real account integration locally

Run the normal Worker and dashboard against a disposable Postgres cluster,
real development OAuth credentials, and Autumn sandbox. The browser simulator
in `packages/auth/smoke/` remains useful for deterministic regressions; it does
not verify provider configuration or payment processing.

## Start isolated Postgres

Run from the repository root. Homebrew PostgreSQL 18 and Infisical dev access
are required. Install PostgreSQL with `brew install postgresql@18` if absent.
There is no need to start a Homebrew service or modify an existing cluster.

```sh
pg_bin="$(brew --prefix postgresql@18)/bin"
account_pg="$(mktemp -d -t epicenter-account-pg)"
account_password="$(openssl rand -hex 24)"
printf '%s' "$account_password" > "$account_pg/password"
chmod 600 "$account_pg/password"

"$pg_bin/initdb" -D "$account_pg/data" -U epicenter \
  --auth-host=scram-sha-256 --auth-local=trust \
  --pwfile="$account_pg/password"
"$pg_bin/pg_ctl" -D "$account_pg/data" -l "$account_pg/postgres.log" \
  -o "-h 127.0.0.1 -p 55432 -k $account_pg" -w start
"$pg_bin/createdb" -h "$account_pg" -p 55432 -U epicenter epicenter_account

export DATABASE_URL="postgres://epicenter:$account_password@127.0.0.1:55432/epicenter_account"
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$DATABASE_URL"
bun run --cwd apps/api db:push:local
bun dev:api-dashboard
```

Stop if any setup command fails. Port 55432 must be free. The temporary
directory is private to your macOS user; socket trust applies only inside it.
TCP connections require the generated password. Keep this terminal's variables
for cleanup. Do not paste the connection string into a commit or chat.

The dashboard is `http://localhost:5178/dashboard`; Vite proxies `/auth` and
`/api` to the local Worker on 8787. The Hyperdrive environment override takes
precedence over `wrangler.jsonc`, so the existing database on 5432 is untouched.
Local Wrangler uses direct Postgres connections, not production Hyperdrive
pooling or caching.

## Register the provider callback

The development OAuth client must allow this exact Google callback:

```text
http://localhost:5178/auth/callback/google
```

Use `/auth/callback/github` or `/auth/callback/microsoft` for those providers.
The application handoff at `/session/callback` is a separate step; do not use it
as the provider callback. Keep credentials in Infisical's `dev` environment at
`/api`. Do not substitute production credentials or disable origin/state checks.

## Align Autumn sandbox

Verify `AUTUMN_SECRET_KEY` is a sandbox key before making changes. Confirm API
plan responses report `env: sandbox`. The installed `atmn` CLI defaults to
sandbox; do not supply production options.

Run these commands from `apps/api`:

```sh
infisical run --silent --env=dev --path=/api -- bun node_modules/atmn/dist/cli.js preview
infisical run --silent --env=dev --path=/api -- bun node_modules/atmn/dist/cli.js push
```

Review the proposed changes before confirming. `preview` renders local pricing;
it is not proof that remote pricing matches. Read the remote plans after a push,
including after an error: a push can partially succeed.

The free plan must have no prices and include 100 MB of storage. The top-up is
$5 per 500 credits, prepaid and one-off. Autumn provides a default Stripe sandbox;
enable its customer portal before testing Manage billing. Never enter a real
card in this exercise.

## Evidence to collect

1. Complete real provider sign-in, return through the hosted Continue screen,
   and reach the dashboard. Verify Postgres contains the provider account and
   independent hosted/application sessions without copying session tokens.
2. Refresh the dashboard and confirm the same identity and real Autumn balance.
3. Purchase one top-up in Stripe test checkout using Stripe's documented test
   card. Check the amount and one-time terms before submitting. Return to the
   dashboard and verify the balance increases by 500, including after refresh.
4. Open Manage billing, confirm it reaches Stripe's portal, then return to the
   same account. Check Usage and Account with no provider errors.
5. Sign out and verify the old application session can no longer authorize
   requests. Sign in again and verify persistence belongs to the same person.

Do not count a seeded session or direct Autumn SDK checkout as a pass for the
browser OAuth-to-payment sequence. Test-account billing records live in Autumn
sandbox independently of the disposable Postgres cluster.

## Stop

After stopping the dashboard with Ctrl+C:

```sh
"$pg_bin/pg_ctl" -D "$account_pg/data" -m fast -w stop
unset DATABASE_URL CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE account_password
```

The directory remains available for inspecting logs or restarting the test.
Delete only that temporary directory when its evidence is no longer needed.

## References

- [Hyperdrive local connection override](https://developers.cloudflare.com/hyperdrive/configuration/local-development/)
- [PostgreSQL cluster initialization](https://www.postgresql.org/docs/current/app-initdb.html)
- [Autumn and Stripe sandbox](https://docs.useautumn.com/documentation/concepts/stripe)
- [Autumn one-time top-ups](https://docs.useautumn.com/examples/prepaid)
- [Stripe test cards](https://docs.stripe.com/testing)
