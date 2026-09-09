# 0372. An opened App exposes its configured remote blob capability

- Status: Proposed
- Date: 2026-09-08
- Unbuilt: Nullable App blob remote and Whispering consumer migration.

## Context

The blob factory selects a remote capability or null. The store currently hides
null behind failing methods. Whispering reconstructs that lost fact from a
separately supplied Account and exposes it as `recordings.remoteAvailable`.

## Decision

The opened App exposes `blobs.remote` as a fixed capability or null. The blob
composition owns its presence. Actual blob methods enforce readiness and their
resource's close/drain contract. Whispering derives remote behavior from this capability and
removes its account-derived constructor flag and `remoteAvailable` property.

Presence means configured, not reachable or currently authorized. Offline and
reauthentication failures remain operation results. Local libraries remain valid.

## Consequences

Callers narrow the capability before use. Backup controls and deletion preflight
preserve the local/remote distinction without a second boolean. Remote failures
must not authorize deleting local audio. The public nullable shape requires a
coordinated core and consumer migration.

## Considered alternatives

- Make `remoteAvailable` readonly: preserves duplicated composition knowledge.
- Infer support from Account presence: can disagree with a custom blob factory.
- Keep only failing stubs: gives UI no direct capability distinction.
- Treat presence as online status: conflates configuration with network results.

## Implementation

See the [execution plan](../../specs/20260908T204224-explicit-core-reads-and-blob-capabilities.md).
