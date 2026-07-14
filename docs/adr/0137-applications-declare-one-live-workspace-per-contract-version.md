# 0137. Applications declare one live workspace per contract version

- **Status:** Accepted
- **Date:** 2026-07-14
- **Supersedes:** [ADR-0136](0136-applications-declare-immutable-data-versions.md)
- **Amends:** [ADR-0135](0135-new-builds-ask-before-initializing-a-new-data-generation.md)
- **Amended by:** [ADR-0140](0140-portable-ownership-has-no-generic-whole-workspace-import.md) (the deterministic live identity has no generic imported copy or same-ID replacement); [ADR-0141](0141-workspace-authority-is-selected-once-and-owns-one-local-database.md) (one workspace ID has an independent live materialization per authority)

## Context

ADR-0136 established the right identity boundary but exposed `dataVersion` in
the application API. The extra qualifier does not distinguish another
developer-authored version axis. It makes the durable contract sound narrower
than it is and competes with ordinary application release terminology.

## Decision

An application declares `defineWorkspace({ appId, version })`, where `version`
is a positive, increasing integer for one complete immutable durable contract.
The framework derives `<appId>-v<number>` as the workspace ID. One principal,
application ID, and version has exactly one forward-moving live workspace.

Software releases are independent of contract versions. Many releases may use
the same version. A breaking durable contract publishes a new version and a
final compatible build may remain available at a versioned historical route.
Runnable historical code is best effort; permanent inspection and complete
export are the stronger promise.

The append-only lock is `workspace-version-lock.json`, with format
`epicenter.workspace-version-lock/1`. Each entry records `version`, its derived
workspace ID, its table schema hash, and the identity of every other declared
durable plane. There is no reader or alias for the former data-version lock.

`recordsEpoch` remains a private records-protocol fence. It identifies one
continuous authority history inside the same workspace version and does not
create another application namespace. The application does not author it.

## Consequences

- Developers author only `appId` and `version`; `workspaceId` and
  `recordsEpoch` remain derived or authority-owned.
- A version change is a deliberate compatibility break, not a release counter.
- Older versions remain independent and writable. The platform does not choose,
  merge, retire, or migrate them.
- The public `dataVersion`, data-version lock name, lock format, and related
  aliases are deleted in the same clean break.
- The server remains unaware of application IDs, versions, predecessor order,
  and historical build routes.

## Considered alternatives

- **Keep `dataVersion`.** Rejected because `version` already names the only
  developer-authored compatibility ordinal in this API.
- **Tie every software release to a version.** Rejected because UI and behavior
  may change without changing durable data.
- **Add a current-workspace pointer or server catalog.** Rejected because a
  deterministic workspace ID already resolves the live namespace and the build
  owns historical navigation.
- **Broaden `recordsEpoch` into a workspace incarnation.** Rejected until an
  actual same-identity whole-workspace replacement workflow earns it.
