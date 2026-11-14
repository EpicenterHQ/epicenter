# 0062. Local Books stores OAuth tokens in a single 0600 file

- **Status:** Accepted
- **Date:** 2026-06-25

## Context

Local Books is a headless CLI (ADR-0047 makes its mirror an agent-facing data daemon); its recurring mode is unattended `sync`, run from cron or a detached session (herdr, tmux, SSH). The store has to work where that mode runs.

The OS keychain does not. Reaching it from a session without a graphic security context fails with `errSecInteractionNotAllowed` (exit 36), and that is an OS security-session gate, not an artifact of how the call is made: a spawned `security` subprocess, a native credential binding, and `Bun.secrets` all hit the same gate identically. So the keychain cannot serve Local Books' primary mode even on the operator's own always-on Mac. The cohort of CLIs that default to the keychain (gh, Supabase, Stripe, Infisical) are desktop consumer tools fronting a hosted SaaS; the cohort built for headless automation (AWS CLI, gcloud, kubectl, Terraform, HashiCorp Vault) is uniformly file-only. Local Books is in the second camp.

An earlier revision of this ADR kept the keychain as an opt-in (`LOCAL_BOOKS_KEYRING=keychain`). That opt-in had no producer: the one mode that could use it (interactive desktop) is not how the tool is run, and keeping it cost a second, untested credential-store code path plus a `TokenStore` discriminated union threaded through config. A field with no live producer earns deletion.

## Decision

OAuth tokens live in a single `0600` `credentials.json` at the data-dir root, kept out of any company's mirror db so the agent's read-only SQL surface (`books_sql_query`) can never read them. There is no keychain backend and no store selection: `createFileTokenStore(config.credentialsPath)` is the only path. The location defaults to the data-dir root and is overridable with `LOCAL_BOOKS_TOKEN_FILE` (the test harness and any custom location). This file store works identically on a desktop, a headless server, an SSH session, and CI.

## Consequences

- The recurring mode (unattended sync over SSH / herdr / CI) works with zero configuration, which is the whole point of a headless-first tool.
- The shape collapses: no store-selection union, no `createKeyring` dispatcher, no `LOCAL_BOOKS_KEYRING` env var, no unknown-value validation, no second untested backend branch. `config.credentialsPath` is a plain string; the token store keeps only its file and in-memory (test) implementations.
- The token is plaintext at rest; the file mode is the protection, the same tradeoff `git credential-store` and `~/.aws/credentials` make.
- The keychain's one real edge over a `0600` file (containment from a backup or cloud-sync sweep) is desktop-only and is not the right future anyway. If at-rest protection ever matters for QuickBooks' long-lived (~100-day) refresh tokens, the named deferred seam is **optional file encryption** (age or libsodium secretbox, with the passphrase suppliable via env so it stays headless), a non-breaking addition layered over the same file path. Build it when a producer exists, not before.

## Considered alternatives

- **Keep the OS keychain as an opt-in backend (`Bun.secrets`).** Rejected. The OS gates session-less keychain access regardless of caller, so it cannot serve the unattended-sync mode that is the tool's reason to exist; the one mode that could reach it (interactive desktop) is not how the tool is run. An opt-in nobody in the primary path can produce is a field with no producer, and it costs a second credential-store branch that the headless test suite cannot exercise.
- **A native credential library (`keytar`, `@napi-rs/keyring`).** Rejected. It does not fix the failure (same OS session gate), and a native `.node` addon fights `bun build --compile` and adds a dependency, breaking the dependency-free single binary.
- **Encrypt the file now.** Rejected as premature. No producer needs at-rest encryption today, and the file-mode protection matches the mainstream posture. Recorded above as the deferred seam so the future need has a designed home rather than a reopened decision.

## Reference

- Implemented in `before-0891-layout:apps/local-books/src/token-store.ts` (`createFileTokenStore`, `createMemoryTokenStore`, and the typed `TokenStore` interface that stores a `TokenSet`), `src/config.ts` (`credentialsPath`), and `src/paths.ts` (`credentialsFilePath`). Builds on ADR-0047 (the mirror as a data daemon) and ADR-0061 (the agent surface whose SQL read this store stays clear of).
