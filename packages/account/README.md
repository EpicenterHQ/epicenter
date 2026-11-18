# @epicenter/account

This package defines the account contracts shared by the hosted API and its
dashboard. The API uses `Principal` and `PrincipalId` for the person on an
authenticated request. The dashboard's
[cookie session](../../apps/api/ui/src/lib/auth/cookie-session.ts) reads
that person from Better Auth and exposes an `AuthClient`.

The dashboard holds one `Account` while the session belongs to the same
person. Account management requests name that person so the server can
check that the cookie still matches. Sign-out or replacement retires the
account and aborts its in-flight requests. The dashboard creates a fresh
account and cache when a different person signs in.

The server owns OAuth registration, token checks, and cookie guards. See
[the shared server](../server/README.md) for those rules and
[the dashboard](../../apps/api/ui/README.md) for local verification.
