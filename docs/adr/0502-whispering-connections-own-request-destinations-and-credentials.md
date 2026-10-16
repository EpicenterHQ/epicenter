# 0502. Whispering connections own request destinations and credentials

- **Status:** Accepted
- **Date:** 2026-10-03
- **Relates:** [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) defines the static connection primitive. This record describes ownership in the current file-based Whispering application.
- **Amended by:** [ADR-0582](0582-whisperings-results-name-the-connection-they-were-sent-over.md) at its two private operation connections, legacy-key adoption, the recipe `endpoint` read as a constraint, and `expectedBaseUrl`: each operation chooses a row of `so.epicenter` by id, nothing an earlier build saved is read, and a result row names the connection it went over.
- **Implementation:** Two private operation connections, explicit setup and legacy-key adoption, one recipe resolver, and request destination confirmation. See [execution evidence](../../apps/whispering/docs/recipe-playground.md).
- **Unbuilt:** Cross-application recipe execution and credential storage independent of the opened folder. This decision introduces neither a shared recipe app nor a connection registry.

## Context

Whispering previously stored an endpoint in portable folder settings and each
recipe, while its device stored one ambient API key. A downloaded or edited
file could therefore change where that key was sent. Attaching a separate
"binding" policy to the key would protect individual requests while leaving
configuration ownership split across private and portable state.

## Decision

The device owns two connections: transcription and text. Each holds its base
URL, default model, and optional bearer key together. Saving changes them in
one storage write. Keeping a key requires the same canonical full base URL;
a new destination requires replacing or removing the key explicitly.

Portable files never choose a credential's destination. A recipe owns its
instructions and optional model preference. An endpoint saved by an earlier
build is a constraint the text connection must match, never a routing target.
New recipes inherit the configured text connection.

A prepared request confirms the endpoint it was prepared for. The workspace
reads the private connection once and sends to that connection's own endpoint
only while it matches. A configuration change cannot retarget a prepared
request. Redirects are refused and ambient cookies omitted.

An earlier ambient key remains unused until the person chooses its destination
in Settings. A launch-provided transcription key belongs to the launch's fixed
transcription connection and is never lent to text. The desktop page receives
connection metadata without the key. Malformed existing storage is reported
and preserved rather than replaced during setup.

## Consequences

Each device needs deliberate connection setup. Bringing a folder to another
device brings recipes and results, without bringing Git-excluded credentials.
A full desktop directory copy still carries its private `.git` files. Browser
connections stay in the site's local storage.

The two operation slots can duplicate an endpoint or key. That small cost is
preferable to introducing connection IDs, discovery, a registry, or credential
resolution before an application needs several selectable connections.

Recipes can be reused by future consumers because their input and output are
plain text. Extracting execution code does not decide where personal recipes
are stored or authorize another app to borrow a credential.

## Considered alternatives

- Bind one ambient key to URLs: retains split configuration and adds policy
  instead of giving the connection ownership.
- Let Git-tracked endpoints select the private key: makes portable content a
  credential-routing authority.
- Add a device connection registry now: adds identity and selection machinery
  for two fixed operations. Reconsider when a real caller needs several
  connections to choose among.
- Automatically move the old key to the endpoint in `kv.json`: trusts portable
  state to decide a secret's destination during migration.
