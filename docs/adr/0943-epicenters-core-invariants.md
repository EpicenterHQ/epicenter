# 0943. Epicenter’s core invariants

- **Status:** Proposed
- **Date:** 2026-11-17
- **Relates:** [ADR-0896](0896-each-collection-has-one-writer-of-record-and-epicenter-never-reconciles-two-writable-copies.md) (one authority per collection), [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) (code and records in one private repository), [ADR-0927](0927-serve-listens-only-on-this-computer.md) (private access), [ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md) (ordinary calls), and [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one action-running process).
- **Unbuilt:** No runtime change is introduced. This records the design commitments and their costs together.

## Context

Epicenter's core invariants state where apps run, where edits count, and
what the owner can change. These commitments guide which guarantees belong
to the platform.

Epicenter's earlier folder sync product kept writable copies on several
devices. That promise required propagation, reconciliation, and a server
that kept every version. The current product gives one person's apps a home
on a computer they control. Other devices reach that home.

Recent changes apply the same reasoning within the home. The CLI sends
actions to the running process instead of becoming another action runner.
Apps save meaningful outcomes in their records instead of depending on a
separate platform run store. Git and the operating system already provide
history and process supervision.

These choices need a shared explanation. "Always on" alone does not remove
reconciliation. "Single writer" can confuse one authority, one process, and
one action at a time. "No state" would incorrectly exclude configuration,
caches, and temporary runtime bookkeeping.

## Decision

**Use Epicenter's core invariants to guide its design. Keep their limits
explicit when deciding which guarantees belong to the platform.**

Epicenter does not need to anticipate every need because its owner can
change the software and compose it with other tools.

| Commitment | What it lets us remove | What we give up |
| --- | --- | --- |
| **Your Epicenter lives on one computer you control and keep running.** Your phone, laptop, and agents reach it through your private connection. | Complete copies and runtimes on every device; distributing the home's service credentials among them; a separate home sign-in system. | Access while the home or its connection is unavailable; automatic failover; public access with separate caller permissions. Outside services still have their own sign-ins. |
| **Every collection has one place where edits count.** That place is the home's folder or an outside source. | Reconciling independently writable copies, merge policies, conflict files, and queues of offline edits to the same collection. | Editing both a source and its copy and expecting them to converge. A cached copy may be stale; a backup does not become another active home. |
| **One running Epicenter process executes every action.** The terminal, browser, and agents all call it. | The CLI's separate action runner and fallback; cross-process action locks and their waits. | Running actions while `serve` is stopped; process isolation between apps; an automatic transaction covering an entire action. |
| **What you make belongs in files you can use without Epicenter.** Apps record outcomes that need to survive; Git checkpoints those files. | Mandatory SDK access to records; a second platform execution history with run IDs, replay, and receipts. | Automatic recovery of unsaved progress and a complete audit of every attempt. An app must save any receipt it needs; Git records checkpoints, not every event. |
| **You can change the software you run.** Each app is ordinary, editable code that you or your agents can inspect and adapt. You choose which code to trust. | Platform settings and extension systems for every specialized need; sandboxing each trusted app. | A promise that every behavior can be configured without code; isolation from a faulty app. The owner is responsible for the code and dependencies they run. |
| **Epicenter composes tools that already do the job.** Git keeps history, Bun manages packages, and the operating system keeps Epicenter running. | Reimplementing version control, package management, and process supervision. | One platform-managed solution to every operational problem. Some work remains ordinary Git, shell, Bun, or operating-system work. |

### One process does not mean one action at a time

One authority prevents disagreement between editable copies. One process
prevents separate platform action runners from racing. Within that process,
a file update reads, decides, and replaces the file without yielding
(`packages/cli/src/disk.ts`). This is what lets platform updates avoid file
locks; one process alone would not protect an asynchronous read followed by
a later write.

Actions can overlap while waiting for a network request or a model. A change
across several files is not a transaction. An editor, agent, or script that
writes files directly is outside the platform's update guarantee. Open files
permit those writers; the owner coordinates them when they touch the same
records. A program replacing a complete file still needs to avoid exposing a
half-written file to readers.

### Specialized guarantees belong where they are needed

An app can add its own deadline, subprocess, receipt, or protection against a
repeated operation. These remain app behavior until a concrete need earns a
shared platform guarantee. Configuration, caches, and temporary runtime
state remain valid; the commitment concerns meaningful outcomes that an app
must remember.

For concurrent editing, a CRDT document can own the live edits and one
exporter can write a saved representation into Epicenter. That representation
is a copy of the source, not an independently editable peer. Alternatively,
the document can transfer into the home and stop being edited at its former
source. Editing both and expecting reconciliation breaks the second
commitment. This does not add a built-in collaboration protocol to Epicenter.

The sixth commitment rejects rebuilding those tools' capabilities. The two
commands that only wrapped them are gone: the person runs Git directly
([ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md)), and
keeps `serve` running under their own operating system job
([ADR-0941](0941-epicenter-serve-is-a-program-you-keep-running.md)).

## Considered alternatives

- **Keep every device independently writable.** It restores offline edits,
  but also restores the reconciliation problem the home model removes.
- **Let the CLI run actions when serve is down.** It introduces another
  writer precisely when the one-process assumption should still hold.
- **Say "Epicenter keeps no state of its own."** It confuses lasting app
  outcomes with configuration, caches, and runtime state. Say who owns the
  information instead.
- **Say "Epicenter does not wrap tools you already have."** It rejects
  useful conveniences along with redundant implementations. Judge whether
  a wrapper expresses an Epicenter operation or rebuilds the underlying tool.
- **Put every specialized guarantee in the platform.** It requires every
  app to inherit machinery its owner could add only where needed.

## Consequences

The six commitments are a design test, not a requirement to delete every
wrapper, guard, or piece of state. A proposed simplification must name the
guarantee it removes and who accepts the loss. A feature that needs a
different authority, trust boundary, or execution model calls for a new
decision rather than an exception hidden in the implementation.

The [vision](../vision.md) presents the commitments in plain English. The
linked records retain their own decisions and status; this record collects
the reasoning without replacing them.
