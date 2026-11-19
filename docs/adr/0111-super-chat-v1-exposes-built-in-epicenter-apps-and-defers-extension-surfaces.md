# 0111. Super Chat v1 exposes built-in Epicenter apps and defers extension surfaces

- **Status:** Accepted
- **Date:** 2026-07-06
- **Supersedes:** ADR-0097
- **Relates:** [ADR-0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md), [ADR-0084](0084-super-chat-shell-is-a-bun-hosted-local-server-not-a-bundled-spa.md), [ADR-0096](0096-local-workspace-persistence-is-environment-injected.md)

## Context

Super Chat needs a smaller v1 than the previous tool-loading decisions implied.
ADR-0080 already makes the super app a desktop host that composes local app
surfaces. ADR-0084 and ADR-0097 then pushed toward loose TypeScript tool modules:
files dropped into a tools directory, imported into the host with Bun, and given
a `ToolHost` API. That loading path is powerful enough to become a scripting
surface, but it also creates a product promise around third-party code execution,
trust, pinning, runtime package compatibility, namespace ownership, and support
before there is a real third-party app to serve.

The useful part of the objection to deleting loose TypeScript is not the loader.
It is scripting: a user may eventually want one program that performs a batch or
conditional workflow, instead of asking the model to make many small tool calls.
That future need is real, but it does not require arbitrary source files to run
inside the Super Chat host process.

## Decision

Super Chat v1 exposes built-in Epicenter apps only. A built-in app is code
Epicenter owns and ships with Super Chat: the host imports the app's canonical
workspace definition, opens a local replica, and exposes its action registry
through the existing tool catalog. There is no user-facing app install flow in
v1.

Loose in-process TypeScript tool modules are removed from the v1 product shape.
Super Chat does not scan a tools directory, dynamically import arbitrary `.ts`
files, or expose a `ToolHost` contract for user or third-party source files. This
replaces ADR-0097 and the tool-loading half of ADR-0084. It does not decide the
shell-packaging half of ADR-0084.

MCP is not a third-party app-install mechanism. It may stay only as a named
external-tool adapter for a concrete integration, such as Local Books, where a
separate process already owns the runtime and data. If no concrete v1 integration
needs it, MCP is removed from Super Chat v1 alongside the loose TypeScript
loader. If it stays, the product language is "external tools," not "installed
apps."

Scripting remains a future trigger, not a v1 extension surface. The default
future shape is an out-of-process script runner: Super Chat calls a script
runner as a tool provider, the runner executes user-authored TypeScript, and the
host receives a bounded result. In-process script loading can be reconsidered
only with an explicit unsafe-developer-mode decision or a real manifest, trust,
pinning, and permission model.

## Consequences

The v1 install story becomes simple: users do not install apps into Super Chat.
They get the canonical Epicenter apps bundled with the host. Future apps become a
release, not a runtime install.

The cleanup deletes the highest-obligation surface: `toolsDir`, the dynamic
loader, the `ToolHost` module contract, fixtures, and tests that exist only to
support loose source imports. It also deletes the need to explain why arbitrary
source files are safe to run inside a host that can read and mutate workspace
replicas.

The trade-off is real. Super Chat v1 does not let a user drop in a TypeScript
file to batch many tool operations. That capability is preserved as a named
future script-runner trigger, where the script executes outside the host process
and can still be invoked by the model, a command palette, or a manual UI.

The data promise stays separate from the extension decision. Built-in apps opened
by Super Chat operate on Super Chat's own local replicas. Making those replicas
converge with app UIs is the signed-in Bun connection and relay-sync slice named
by ADR-0096, not a plugin-loading concern.

## Re-entry triggers

Reopen third-party workspace app install when a real third-party workspace app
exists and a release-bundled built-in path cannot serve it. Start from a manifest
contract: app identity, workspace id, package version, action schemas,
permissions, trust, pinning, and namespace allocation.

Reopen scripting when a real workflow needs many tool calls and would be simpler
as one user-authored program. Start from an out-of-process TypeScript script
runner that exposes `scripts/list` and `scripts/run` through the tool catalog or
MCP, not from host-side dynamic import. When that work starts, use PR #2390 and
the removed `tool-loader.ts` / `tool-module.ts` code as reference material for
the old obligations and ergonomics, but redesign the scripting surface from
scratch instead of resurrecting the deleted host-import contract.

Reopen in-process user code only if the product explicitly wants unsafe local
developer automation, and record it as such. The default app and scripting paths
must not quietly inherit ambient host trust.

## Considered alternatives

Keep loose TypeScript modules: rejected for v1. They solve a possible scripting
need by creating an app-install and code-trust surface before either is earned.

Make MCP the only extension mechanism: rejected as the v1 app story. MCP remains
useful for external tool processes, but it is not how built-in Epicenter apps
should be exposed, and it is not a workspace-app install contract.

Build a third-party workspace-app manifest now: rejected. The manifest path is
the right future front door, but it needs a real third-party app and explicit
trust, pinning, schema, permission, and namespace decisions.

Build a local daemon or action bus now: rejected. It couples Super Chat to a
machine-local lifecycle surface before the relay-sync path for built-in replicas
has been exercised.
