# 0927. `serve` listens only on this computer, and the owner's network brings other devices in

- **Status:** Accepted (2026-11-16)
- **Date:** 2026-11-16
- **Amends:** [ADR-0883](0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md) on the listener: `serve` binds only `127.0.0.1`, and `--host` and `--port` are gone.
- **Amends:** [ADR-0903](0903-the-home-is-a-computer-its-person-controls-owned-or-rented.md) at "`serve` binds to loopback or a tailnet address only": loopback only, on a rented home too.
- **Relates:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) (one person's software), [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (`EPICENTER.md` and its `port`), [ADR-0878](0878-the-os-keeps-epicenter-serve-running-under-a-job-the-person-installs.md) (the macOS job), [ADR-0903](0903-the-home-is-a-computer-its-person-controls-owned-or-rented.md) (owned or rented).

## Context

`serve` signs no one in, so the address it listens on decides who can call
every action. ADR-0883 left that to the host, and `serve --host` accepted any
address. `--host 0.0.0.0` on café Wi-Fi offered every action, with no
sign-in, to everyone on that network. The trust model could only warn
against it.

Nothing the owner runs needs that flag. The macOS login job starts plain
`epicenter serve`. Other devices reach it through `tailscale serve`, a proxy
on the same computer that connects to `127.0.0.1`. `serve --port` duplicated
the `port` in `EPICENTER.md`, and `service status` and routines read the
marker, so the flag could make them report the wrong port.

## Decision

Epicenter runs on a computer its owner controls and keeps on. `serve`
listens only on `127.0.0.1`, at the port in `EPICENTER.md` (default 4747),
and takes no flags. Reaching it from another device is the owner's network's
job: a private proxy on this computer connects to that port. `tailscale
serve` is the recommended one; Epicenter does not require Tailscale.

`serve` keeps its request checks, because a page in the owner's own browser
can still send requests to loopback. It answers only a loopback, IP, or
`*.ts.net` `Host`, requires `Origin` to match `Host`, and refuses the headers
a Tailscale Funnel or Cloudflare Tunnel adds.

## Consequences

- `serve` cannot be made reachable from a network by itself. Exposing it is a
  separate, deliberate step through a proxy the owner runs.
- A second, temporary `serve` on another port means another Epicenter, or an
  edit to `EPICENTER.md`. Tests use `port: 0` in the marker for a free port.
- A proxy other than `tailscale serve` must send a `Host` the check accepts,
  such as `localhost`. A setting for other names waits for a real proxy that
  needs it.
- A rented computer or a container ([ADR-0903](0903-the-home-is-a-computer-its-person-controls-owned-or-rented.md))
  runs its proxy beside `serve` in the same way. A hosted Epicenter behind
  Epicenter's own sign-in is not decided here.

## Considered alternatives

- **Keep `--host`, accepting only loopback and Tailscale addresses.** It
  keeps a way around the proxy, and `100.64.0.0/10` is shared address space
  that Tailscale does not own, so the check guesses.
- **Require Tailscale.** It deletes nothing that listening on loopback does
  not already delete, and it rules out SSH tunnels and other private networks.
- **Give `serve` its own sign-in, such as a token.** Then any exposure would be
  safe, but a single owner on a private network does not need it, and
  ADR-0881 removed sign-in from `serve` for the same reason.
