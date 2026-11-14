# 0903. The home is a computer its person controls, never one Epicenter supplies

- **Status:** Accepted (2026-11-14)
- **Date:** 2026-11-14
- **Amends:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at "Epicenter Cloud for a page without Git": a page without Git asks `serve` on the home (ADR-0860), and nothing else supplies `folder`.
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at "Anything without Git reaches it only through Epicenter Cloud": it asks `serve` on the home, and the Epicenter Cloud file API is withdrawn.
- **Amends:** [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at "Epicenter Cloud is a hosted box": withdrawn; a person's box is a home they control.
- **Amends:** [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) at the table of who can read a `.local` file: the provider of a rented home can, and nothing in Epicenter stops it.
- **Amends:** [ADR-0883](0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md) at its Open items about a hosting service: closed, since Epicenter builds nothing for one; its test, a container per person, stands for a container the person rents.
- **Amends:** [ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md) at "the host's token on a hosted Epicenter": withdrawn; whoever may call the app's actions on the home may clone and push.
- **Relates:** [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (code runs where its owner trusts it), [ADR-0878](0878-the-os-keeps-epicenter-serve-running-under-a-job-the-person-installs.md) (the job that keeps `serve` running), [ADR-0897](0897-hosted-notes-is-a-product-beside-epicenter-and-waits-for-a-month-of-evidence.md) (hosted Notes), [ADR-0898](0898-what-arrives-is-cached-what-the-person-decides-is-kept-and-an-item-moves-by-transfer.md) ("a hosted home" is Never), [ADR-0899](0899-the-folder-sync-product-is-retired.md) (the product Epicenter Cloud belonged to), [ADR-0901](0901-an-app-is-inside-an-epicenter-or-outside-it.md) (a service is an outside app).
- **Unbuilt:** the Linux job for a rented home, ADR-0878's systemd user unit, and `serve` refusing to bind anything but loopback or a tailnet address.

## Context

ADR-0849 made your server "a computer the person keeps on", for the author the
Mac Studio. Three records left a hosted one open: ADR-0849 and ADR-0864 called
a hosted server for a person who keeps no computer on "not decided", and
ADR-0865 "not decided here". Older accepted records assumed one: ADR-0844 made
Epicenter Cloud "a hosted box" a person could choose instead of their own,
ADR-0841 and ADR-0842 sent anything without Git through Epicenter Cloud, and
ADR-0883 and ADR-0887 tested their designs against a hosted Epicenter.

ADR-0898 then listed "a hosted home" under Never, and ADR-0899 retired the
folder sync product that Epicenter Cloud belonged to. Neither said what a
person with no computer to leave on does, or whether a rented one counts.

Providers sell per-person machines today (checked 2026-11-13): Fly's Sprites
and Dedalus Machines are virtual machines that sleep when idle and keep their
disk, and Zo Computer keeps one on per paid plan. Running such a fleet takes
virtual machines on bare metal, block storage kept in object storage, a proxy
that wakes a machine for a request, abuse handling, and custody of each
person's sign-ins. Server memory, the scarce input, rose sharply in price
through 2026.

## Decision

**The home is a computer its person controls.** They hold root on it, it runs
only the code they trust, and they chose whom to trust with its hardware. It is
owned, such as a Mac at home, or rented, such as a Linux server from a hosting
provider. For the author it is the Mac Studio. The same `epicenter` runs on
either, and the operating system keeps `serve` running under a job the person
installs (ADR-0878): a LaunchAgent on macOS, a systemd user unit on Linux.

**Epicenter never supplies a home.** It ships the program. It runs no person's
`~/Epicenter`, `serve`, or app code on its own machines, and holds none of
their sign-ins.

**What Epicenter, the company, hosts is a service.** Today that is `apps/api`;
hosted Notes, if it is built (ADR-0897). From a home each is an outside app
like Gmail: pulled, moved from, or changed by an action (ADR-0898,
ADR-0901). The company's revenue comes from its services, never from homes
(`FINANCIAL_SUSTAINABILITY.md`).

**Renting a home trusts its provider.** The provider can read the disk and its
snapshots, every `.local` file included. Epicenter adds nothing against that;
the person chooses a provider as they choose which agents get a shell.

**Anyone else may host homes.** The AGPL allows it and makes them publish what
they change (`docs/licensing/licensing-strategy.md`, scenario 5). Epicenter
builds nothing for a hosting service.

## Consequences

- A person with no computer to leave on rents one, and nothing waits on a
  hosted Epicenter.
- A rented home stays on. People reach `serve` over the tailnet, and a machine
  asleep cannot answer there, since its Tailscale is asleep too.
- A rented Linux home has no Mac app: it is set up over SSH with `epicenter`
  and `epicenter service install`, and its person enables linger so the job
  runs without a login.
- An outage on a rented home is the provider's restart, not FileVault's unlock
  screen.
- `serve` binds to loopback or a tailnet address only, since a rented server
  usually has a public one and `serve` signs no one in.
- ADR-0849, ADR-0852, ADR-0856, ADR-0864, and ADR-0865, still Proposed, are
  edited to match.

## Considered alternatives

- **Epicenter hosts homes,** as per-person machines that sleep, with their
  disks in object storage. Building that is a fleet, durable block storage, a
  wake proxy, abuse handling, and custody of every person's sign-ins; reselling
  another provider's is the custody without the fleet. Either brings back what
  ADR-0864 refused: running other people's code and holding their credentials.
- **Owned computers only.** Leaves out a person whose only always-on computer
  is rented, and changes nothing in the program.
- **Leave hosting undecided,** as ADR-0849, ADR-0864, and ADR-0865 did. Records
  kept designing for a hosted case that no one plans to build, such as
  ADR-0883's Open items.
