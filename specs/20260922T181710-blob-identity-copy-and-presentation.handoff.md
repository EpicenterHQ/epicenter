# Execute the blob identity, copy, and presentation API

Implement and verify the settled blob API through real callers in:

```text
/Users/braden/conductor/workspaces/epicenter/yamoussoukro
```

Read the canonical execution plan:

```text
specs/20260922T181710-blob-identity-copy-and-presentation.md
```

Its linked ADRs 0372, 0426, and 0427 define the target. ADRs 0349, 0366, and
0393 preserve local publication, recorder ownership, and independent row
references. Read current code/READMEs to establish implementation state. This
handoff is an implementation assignment, not another planning-only pass.

The user converged on independent stores after exploring constructor coupling,
mandatory local caching, get/put composition, and a top-level copy function.
Do not recreate those discarded public shapes. The intended developer workflows
are saving new bytes, copying existing objects, reading bytes for computation,
and opening local or remote media with one player source contract.

Target shape:

```ts
const local = await openLocalBlobs({ id: sourceNamespace });
const remote = await openRemoteBlobs({ id: destinationNamespace, account });

const added = await local.add(bytes);
if (added.error) return added;
const copied = await remote.copyFrom(local, added.data, { signal });
if (copied.error) return copied;
return remote.open(added.data);
```

Both stores expose add/get/open/delete and identity-preserving copyFrom for their
supported sources. Local retains stat/list; do not invent remote enumeration for
symmetry. add creates a BlobId; copyFrom preserves it; get returns a complete
Blob without another persistent copy; open returns a disposable presentation URL
without requiring offline retention. Only explicit local.copyFrom(remote,id)
promises a complete local copy. Public put, destination-ID overrides, upload,
download, addFrom/addLocal, and top-level copyBlob are not part of the target.
Raw publication remains private where actual adapters/producers need it.

Addressing is deliberate:

```text
Browser: epicenter/<namespace>/device/no-account/blobs, blobs[blobId]
Desktop: <dataRoot>/apps/<namespace>/device/no-account/blobs/<blobId>
Remote:  principals/<principalId>/apps/<namespace>/blobs/<blobId>
         inside the captured server's object-storage bucket
```

Namespace id and object blobId are different values. Namespace uses the current
application-ID grammar. Local bytes are account-independent. Remote authority,
principal, namespace, and BlobId together locate an authorized placement. Copies
may cross namespaces. Same opaque ID does not prove equality across untrusted
locations or grant access. Never overwrite an occupied key: verified equal bytes
may succeed idempotently; different or unverifiable bytes produce a conflict.
Copies leave their source intact and expose no partial destination objects.

Current implementation still uses remote.upload(local,id), fresh server IDs,
URL-addressed remote reads, and full-download remote presentation. The upload
endpoint caps bytes at 25 MiB and buffers them. Native upload already streams a
host file without routing its payload through the WebView; preserve that path
under copyFrom. A Blob does not automatically imply JS-heap copying, but the
current get/broker paths have full-body barriers. Measure before claiming costs.

Private remote playback is real work: media elements do not use Account.fetch.
Prove authorized range/HEAD requests, delayed seeks, expiry, disposal, and
account replacement on browser and desktop. Do not simply derive a URL, expose
account tokens, make private objects public, or weaken content-serving protection.
Remote opening must not persist locally. Players must handle errors after open
succeeds. Do not claim large-video support merely by changing open or raising a cap.

Start by capturing git status, name-status, binary working and index patches,
untracked files, and focused baseline diagnostics. There is substantial unrelated
work. Do not reset, erase, stage, or include it in your changes. The documentation
preparation baseline in /tmp is historical evidence only; it may not exist in a
fresh session. Capture your own. No data migration, deployment, push, or commits
are authorized by this handoff alone. The user authorized the preparation docs
commit separately. Use Bun and repository skills.

Trace at least packages/app blob/recorder owners, packages/blobs adapters and
publication, packages/client remote transport, packages/server blob routes/S3,
apps/epicenter host relay/native files, auth transports, and Whispering
recordings/upload/playback/transcription/download/availability callers. Follow
actual imports beyond that list. Existing README exports are implementation
facts, not permission to retain obsolete target APIs.

Execute the plan's waves with independent adversarial-review checkpoints:

1. Reconstruct owners and decide protocol evidence gates before broad migration.
2. Build/prove immutable publication and retry equality; review before transfer.
3. Build/prove supported copy pairs and native/browser transport; review before callers.
4. Build/prove authenticated remote media delivery; review before removing old playback.
5. Migrate actual application workflows and references; review cumulative callers.
6. Switch, verify, remove obsolete paths, run local post-implementation-review,
   and finish current documentation.

Each checkpoint reviews cumulative behavior and remaining work. Resolve findings,
rewrite obsolete tasks, and continue; a checkpoint does not end the assignment.
Use parallel read-only reviewers and bounded investigations when available.
Keep live-checkout edits and integration under one owner. Report unavailable
reviewer/runtime evidence rather than pretending it occurred.

Before deleting audioUrl, establish where the row obtains remote server,
principal, and namespace. Local rows survive account switches. Same-ID copying
removes the second identity, not missing placement metadata. A separate placement
write can still fail after copy; retain completed identity and destination scope.
Do not blindly copy again to repair that write. Stop still saves bytes before
row creation, and a later row failure retains the saved ID. One final caller owns
error presentation. Keep playback/transfer independent of recording, transcript,
and row deletion policies.

Mechanics still needing evidence are identified in the plan: copy source matrix,
verified collision/retry mechanism, ambiguous remote add receipts, playback
authorization lifetime, upload limits/buffering, and placement-reference shape.
Choose implementation mechanics autonomously within the settled contracts. If a
mechanism requires changing a user-visible security/retention promise, surface
that precise decision and continue independent work rather than silently weaken it.

Use the plan's focused Bun tests/typechecks and real browser/native media checks.
Prove same IDs/exact bytes, conflicts and interrupted copies, offline local use,
remote start/seek before full download, no local write during playback, explicit
offline retention, and captured-account behavior. Passing library tests alone is
not completion. Attribute failures against the fresh baseline, not memory of
previous sessions. Do not reuse historical test counts.

Return the final API and real callsites, concrete deleted machinery, verification
with measured limits, and precise remaining blockers or product decisions. Retire
the spent spec/handoff and update history when execution is complete; keep ADR
status separate from implementation state.
