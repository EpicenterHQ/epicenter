# 0639. Automatic commits refuse new non-text content

- **Status:** Proposed
- **Date:** 2026-10-19
- **Amends:** [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) at its exhaustive list of synchronization refusals and causes of `stuck`; and [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) at an eligible binary file always entering an Epicenter-created commit.
- **Relates:** [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) (the library's text boundary) and [ADR-0620](0620-history-in-a-repository-only-grows.md) (already-made commits are not rewritten).
- **Unbuilt:** preflight of the native files and index entries an Epicenter-created commit would include, a named-path refusal in the CLI and app status, and checks for ignored, tracked, staged, already-committed, incoming, and deleted binary paths.

## Context

The data library writes text, but a native recorder or another program can
write binary files into a selected directory. `.gitignore` keeps Whispering's
`audio/` local by default. Removing that line, adding an exception, or already
tracking an audio path could make a recording eligible when Epicenter next
constructs a commit. Silently uploading it would turn a local save into media
synchronization. Silently skipping it would make synchronization look complete
while eligible work was left behind.

Ordinary Git can also contain intentionally committed binary files. A client
must still carry incoming objects and push commits that already exist; Git
history only grows under ADR-0620.

## Decision

**Before Epicenter constructs a commit from local state, it refuses new or
changed non-text content that the commit would include and names each affected
path.** Eligibility follows Git's tracked-file and ignore rules, including
staged content that has not yet been committed. Non-text uses the
same UTF-8-without-NUL boundary as ADR-0621. The refusal leaves the files and
existing commits intact and makes synchronization `stuck` until the person
restores an ignore rule, removes the eligible change, or commits it deliberately
with ordinary Git. Epicenter does not quietly omit an eligible file and report
the folder as synced.

**The check applies to commit construction, not to transport of existing
history.** Ignored files do not trigger it. An unchanged binary entry and a
deletion introduce no new bytes. Incoming Git binary objects remain readable
and transferable. A commit already created by ordinary Git, including one
that deliberately adds audio, can be pushed by `epicenter sync`; the command
does not rewrite or filter it. If such a commit is pending, sync may push it
before reporting that a later automatic commit is blocked by local non-text
content. The rule is a guard on Epicenter's automatic publication, not a
guarantee that audio can never leave a device.

## Consequences

- An accidental ignore-rule change cannot make an Epicenter-created commit
  upload local recordings without a visible refusal.
- A person can intentionally use plain Git for binary history. Existing
  pending commits retain their identity across sync retries.
- A changed tracked binary can block an automatic text commit until someone
  resolves it. The app must keep local saves accessible while reporting the
  path that needs attention.
- Browser clients that only save text still carry untouched binary content
  from Git without gaining a binary-write API.

## Considered alternatives

- **Trust `.gitignore` alone.** One removed rule can make all saved audio
  eligible for the next automatic commit.
- **Silently skip eligible non-text files.** The person sees a synced state
  while their eligible local changes were not committed.
- **Refuse a push containing any binary object.** Blocks deliberate Git
  commits and incoming history after those commits already exist.
