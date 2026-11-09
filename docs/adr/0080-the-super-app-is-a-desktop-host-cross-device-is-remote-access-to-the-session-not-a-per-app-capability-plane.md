# 0080. The super app is a desktop host; cross-device is remote access to the session, not a per-app capability plane

- **Status:** Accepted (the desktop-host decision is settled; the [Trigger to revisit](#trigger-to-revisit) is resolved by [ADR-0115](0115-super-chat-remote-attach-rides-an-endpoint-addressed-trusted-relay.md): Epicenter operates an endpoint-addressed trusted AttachRelay)
- **Date:** 2026-06-30
- **Amended by:** [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) at the host session a remote device attaches to: no TypeScript host runs, so no session exists, and agents reach folders through `git`, the `epicenter` CLI, and the MCP server (ADR-0550).
- **Relates:** [ADR-0079](0079-cross-device-is-two-planes-epicenter-syncs-the-crdt-the-box-is-reached-directly.md) (this refines its capability plane: the super app does not consume it), [ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md) (the agent loop runs in the client), [ADR-0021](0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md) (actions cross process boundaries), [ADR-0072](0072-local-books-ships-as-a-standalone-cli-the-daemon-surface-is-deferred.md) (Local Books is off the mesh, a local MCP verb facade), [ADR-0073](0073-tools-speak-mcp-natively-epicenter-owns-only-the-transport-mcp-lacks.md) (tools speak MCP), [ADR-0078](0078-inference-is-a-url-addressed-connection-the-relay-floor-carries-only-tools.md) (inference is a URL connection), [ADR-0004](0004-trust-the-relay-reject-zero-knowledge.md) (the relay reads plaintext)

## Context

<!-- doc-path-check: ignore-next-line -->
The super app is an Epicenter chat that discovers and invokes the headless actions of your other apps so it can dispatch on your behalf. Grounding it against the code (an 11-agent investigation that hunted dispatch, invoke, `defineActions`, MCP-over-the-wire, the relay floor, and jsrepo) surfaced three facts. First, the discover-and-invoke machine already ships and is purely in-process: `createLocalToolCatalog(registry)` projects any action registry into agent tools, `composeToolCatalogs([...])` merges N of them, and `apps/opensidian/src/lib/session.ts` already feeds the merged surface to one transport-blind agent loop. Second, the super app composes verbs, never another app's SQLite, which is each app's private per-runtime derived cache. Third, the hard parts of making the super app cross-device (a per-app `/mcp` endpoint over the user's overlay, a synced directory of per-box endpoints, per-box headless identity, a browser and mobile WASM materializer, build-time bundling of app code into a mobile binary) exist for one purpose: to make N apps individually reachable from M devices, chiefly a phone.

ADR-0079 answered "reach a tool on your box from your phone" with a per-app capability plane. The super app does not need that. It runs where the apps and data already are, so the only thing that must cross a device boundary is the user's view of the one running session. That is a single product refusal that collapses the entire per-app cross-device apparatus.

## Decision

1. **The super app is a single host process on the user's desktop or always-on box.** It composes only local app surfaces: in-process action registries for user-curated Yjs apps (import the app's isomorphic `WorkspaceDefinition {tables, kv, actions}`, open it as a local peer, `createLocalToolCatalog(app.actions)`), and local stdio MCP verb facades for cloud-upstream apps that refuse the workspace mesh by design (Local Books today, Gmail next). It never reaches an app over a network. The composition primitive already ships; the unbuilt piece is the host that opens several apps side by side.

2. **Cross-device use of the super app is remote access to the host session, not cross-device access to apps.** A phone or any second device attaches to the one desktop session as a thin client: the Codex-app, Claude-remote, SSH-plus-tmux, VS-Code-Remote shape. It does not run the super app and does not reach apps directly. Exactly one thing is made remotely reachable: the host session.

3. **This refines ADR-0079.** The per-app capability plane is not built as the super app's cross-device mechanism. Reaching one host as a session replaces reaching N apps as endpoints. The relay floor deletion (ADR-0079) stands; the direct `/mcp` daemon, the synced boxes directory, and headless box identity are not super-app dependencies. The capability plane may still be earned for some non-super-app consumer later, but the super app does not require it, so it is not built for this.

4. **Individual apps stay per-device and become cross-device by being installed per device** (the sync plane for user-curated data, per-device CDC from the upstream cloud for cloud-upstream data). Reading email on a phone is the email app on the phone, not the super app reaching the desktop's email. The super app is the orchestration layer across your installed apps, and it is desktop-only.

5. **The remote-access channel follows the deployment trust model.** A super-app session streams prompts, responses, approvals, and tool results. Hosted Epicenter is trusted infrastructure for those live frames, the same way the sync anchor is trusted for plaintext workspace data (ADR-0004). The private answer is topology: run self-host when the operator must not see Super Chat data. This deliberately retires the earlier seam-2 exception that required an end-to-end encrypted hosted broker before turnkey mobile remote could ship.

## Consequences

- **The super app loses its dependence on the capability plane.** Deleted from the super app's plan: per-app `/mcp` over the overlay, the boxes directory, per-box headless identity, the mobile in-process host, build-time bundling of app code for mobile, and the browser and mobile WASM materializer requirement. The earlier three-arm model (A in-process, B local MCP, C remote per-app MCP) collapses: A and B are same-desktop, and C is replaced by the single host-session remote channel.
- **The wedge is unaffected.** Whispering is not the super app. It ships on the sync plane and runs standalone on every device. Making the super app desktop-only does not touch the go-to-market.
- **Cost: there is no super app without a desktop or always-on host.** A phone-only user gets their individual apps (which sync) but not the cross-app agent; they get it by remoting into a desktop. This matches the power-user-platform-earned-later positioning and the Obsidian model.
- **The session inherits the deployment trust model.** Because the session carries tool results, hosted Epicenter can observe those live frames. That is intentional, not a hidden exception: privacy-sensitive deployments self-host. The remote channel still stores no frames and exposes no per-app capability surface.
- **The system gets simpler to explain.** One desktop host, composing local verbs, viewed remotely as a session. The NAT rendezvous does not vanish (physics, ADR-0079), but it relocates to a single off-the-shelf remote-host channel reached as a session, not a per-app protocol Epicenter maintains.

## Trigger to revisit

Is mass-market remote access to the super app a committed product goal, that is, a phone user with no desktop, or one-tap remote without the user configuring an overlay? If yes, build an endpoint-addressed trusted relay for the host session, or a turnkey overlay; reopen whether a thin per-tool reach beats a full session at that point. If no, the bring-your-own-Tailscale-to-desktop answer stands and Epicenter operates nothing for the super app.

### Update 2026-07-07: resolved toward the AttachRelay (ADR-0115)

The trigger fired yes: turnkey phone attach after Epicenter sign-in is a committed direction. It is delivered by the endpoint-addressed trusted AttachRelay (ADR-0115). The relay forwards live Super Chat bytes between two of the principal's endpoints, addressed by `principalId`, `hostId`, `deviceId`, and `attachId`; it stores no frames and exposes no route/capability/tool surface. Hosted Cloud is trusted for live frames, and self-host is the privacy answer. This is not a per-app capability plane and does not resurrect the relay floor (ADR-0086). The "thin per-tool reach versus full session" question stays closed: the full host session is the one reachable surface, per this ADR's decision 2.

## Considered alternatives

- **A mobile-native super app (build-time bundling, or a thin client per app).** Rejected. It requires a mobile and browser WASM materializer, per-app cross-device reach, and per-box identity, the exact complexity this decision deletes, to deliver a phone experience that remote-into-host delivers over one channel.
- **Keep the per-app capability plane (ADR-0079 as-is) as the super app's cross-device mechanism.** Refined away. Reaching N apps as individually addressed endpoints is more apparatus than reaching one host as a session, and because the super app composes apps locally it never needs them addressable over a network.
- **A content-readable hosted session broker (the Codex or Claude remote pattern).** Accepted by ADR-0115's amendment, but only as an endpoint-addressed Super Chat attach relay, not as a generic remote capability broker. This is the privacy-equals-self-host stance applied to live Super Chat frames.
- **A bespoke remote-session protocol.** Rejected. Remote-into-a-host is a solved, off-the-shelf shape (Tailscale SSH, a tunneled web terminal, the Codex and Claude remote patterns). Epicenter should reuse it, not rebuild it.
