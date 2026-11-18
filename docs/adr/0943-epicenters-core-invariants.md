# 0943. Epicenter’s core invariants

- **Status:** Proposed
- **Date:** 2026-11-17
- **Relates:** [ADR-0896](0896-each-collection-has-one-writer-of-record-and-epicenter-never-reconciles-two-writable-copies.md) (one authority per collection), [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) (code and records in one private repository), [ADR-0927](0927-serve-listens-only-on-this-computer.md) (private access), [ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md) (ordinary calls), and [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one action-running process).
- **Unbuilt:** Three rules state code that does not exist yet. Rule 2 waits on [ADR-0959](0959-serve-loads-each-app-once-and-an-apps-code-changes-when-serve-restarts.md) for reading code once at start, and on [ADR-0961](0961-the-command-sends-an-actions-words-to-serve-and-serve-alone-reads-them.md) for a command that loads no app. Rule 3 waits on [ADR-0960](0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md) for the folder as an argument. Rule 4 waits on [ADR-0963](0963-local-ignores-itself-and-serve-refuses-a-dotenv-that-git-would-commit.md).

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
| **What you make belongs in files you can use without Epicenter.** Apps record outcomes that need to survive; Git keeps the history their owner commits. | Mandatory SDK access to records; a second platform execution history with run IDs, replay, and receipts. | Automatic recovery of unsaved progress and a complete audit of every attempt. An app must save any receipt it needs; Git records the commits its owner makes, not every event. |
| **You can change the software you run.** Each app is ordinary, editable code that you or your agents can inspect and adapt. You choose which code to trust. | Platform settings and extension systems for every specialized need; sandboxing each trusted app. | A promise that every behavior can be configured without code; isolation from a faulty app. The owner is responsible for the code and dependencies they run. |
| **Epicenter composes tools that already do the job.** Git keeps history, Bun manages packages, and the operating system keeps Epicenter running. | Reimplementing version control, package management, and process supervision. | One platform-managed solution to every operational problem. Some work remains ordinary Git, shell, Bun, or operating-system work. |

### Six rules for checking a proposal

The commitments are long to hold in mind while judging a proposal. These
six rules are the short form. For a proposed feature, ask which rule
already answers it; when the answer is that a tool or the owner does the
work, the feature is a line of documentation, not code.

| Rule | Restates |
| --- | --- |
| 1. Your Epicenter is a folder: one Git repository and one Bun project. Data is files in it and Git is the history. Each record has one place where edits count: this folder, or the outside source it copies. | The second and fourth commitments; [ADR-0896](0896-each-collection-has-one-writer-of-record-and-epicenter-never-reconciles-two-writable-copies.md), [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md), [ADR-0942](0942-a-home-is-one-bun-workspace-and-epicenter-is-a-dependency-of-it.md) |
| 2. Serve is the one program that loads and runs app code. It reads code and packages when it starts, and you restart it to change them. The command, pages, agents and routines are its clients. | The first and third commitments; [ADR-0936](0936-one-serve-per-home-runs-every-action.md), [ADR-0941](0941-epicenter-serve-is-a-program-you-keep-running.md), [ADR-0959](0959-serve-loads-each-app-once-and-an-apps-code-changes-when-serve-restarts.md), [ADR-0961](0961-the-command-sends-an-actions-words-to-serve-and-serve-alone-reads-them.md) |
| 3. An action is a function of its app's folder: JSON in, `{ data, error }` out, described in plain JSON. What must outlast the call goes in a file. | The fourth commitment; [ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md), [ADR-0953](0953-an-actions-answer-is-data-or-error-and-its-input-is-one-json-schema.md), [ADR-0960](0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md), [ADR-0964](0964-a-folder-is-on-disk-and-it-holds-a-path-and-the-calls-that-change-files.md) |
| 4. `local/` ignores itself, and serve refuses a `.env` that Git would commit. | [ADR-0939](0939-what-stays-on-this-computer-lives-in-an-apps-local-folder.md), [ADR-0949](0949-an-action-calls-a-model-with-plain-code-and-epicenter-adds-no-function-for-it.md), [ADR-0963](0963-local-ignores-itself-and-serve-refuses-a-dotenv-that-git-would-commit.md) |
| 5. The code is yours. The only setting is the port. | The fifth commitment |
| 6. Epicenter does only what needs an app's declaration or the running serve. Everything else is a line in the README. One exception: where a skipped step fails silently and cannot be undone, Epicenter refuses or reports. It never repairs. | The sixth commitment; [ADR-0955](0955-no-command-makes-or-copies-an-app.md), [ADR-0958](0958-no-command-makes-an-epicenter.md) |

Rule 2's second sentence holds once ADR-0959 is built; until then serve
re-imports an app's own code on each call. Rule 4 holds once ADR-0963 is
built; until then the owner's `.gitignore` is the only guard.

### Why six rules replaced eight

The eight rules this table replaces were:

1. Your Epicenter is a folder: a Git repository that is also a Bun project.
2. Serve is a program: you start it, stop it, and restart it after its
   packages change. An app's own code reloads on each call.
3. An action is a function: JSON in, JSON out, with optional updates on the
   way.
4. Data is files, and Git is the history. `apps/*/local/` and `.env` stay
   out of Git on purpose.
5. Every description is plain JSON.
6. The code is yours: copy it and edit it. No Epicenter setting beyond
   `EPICENTER.md`.
7. If a tool does it in a step the owner would type, Epicenter does not.
8. Serve keeps no outcome between calls: anything an app must remember goes
   in a file.

- Old rules 3, 5 and 8 said one thing about an action: it is a function,
  what it takes and gives is JSON, and nothing outlasts it except a file.
  Rule 3 says it once, and names the folder as the function's only
  argument (ADR-0960).
- Two commitments had no rule: one place where edits count, and one process
  that runs every action. A proposal could pass all eight rules and still
  fail them. They are now part of rules 1 and 2, so a writable copy fails
  rule 1 and a second action runner fails rule 2.
- Old rule 4 put data and secrets in one sentence and stated an intention
  for the secrets. Data joins the folder in rule 1. Rule 4 states what keeps
  secrets out: a file `local/` writes for itself, and a check serve makes at
  start (ADR-0963).
- Old rule 7 tested "a step the owner would type". It could not explain what
  stays: a cron line is one typed step, yet routines stay. Its exception
  named `new --from` and `export`, and both commands are gone
  ([ADR-0955](0955-no-command-makes-or-copies-an-app.md)). Rule 6 asks a
  question that sorts every case.
- Old rule 2 said an app's code reloads on each call. Rule 2 now says serve
  reads code once, at start (ADR-0959).

### What stays code

Rule 6 sorts a proposal with one question: **does this need an app's
declaration, or the running serve?** If it does, it is Epicenter's code. If
it does not, it is a line in the command's README.

| Proposal | Needs a declaration or serve? | Result |
| --- | --- | --- |
| Running an action | Both | Code |
| The listing: bare `epicenter`, `--json`, MCP `tools/list` | Both | Code |
| `epicenter check` | The declaration | Code |
| Routines | Serve, reading files in `routines/` | Code |
| Refusing a call meant for another Epicenter | Serve | Code |
| `new`, copying an app | Neither: `mkdir` and `curl` | Documentation ([ADR-0955](0955-no-command-makes-or-copies-an-app.md)) |
| `export`, publishing an app's code | Neither: Git | Documentation ([ADR-0955](0955-no-command-makes-or-copies-an-app.md)) |
| `init`, making an Epicenter | Neither: a few files, `git init` and `bun install` | Documentation ([ADR-0958](0958-no-command-makes-an-epicenter.md)) |
| `install` | Neither: `bun install` | Documentation ([ADR-0942](0942-a-home-is-one-bun-workspace-and-epicenter-is-a-dependency-of-it.md)) |
| `service`, keeping serve running | Neither: launchd or systemd | Documentation ([ADR-0941](0941-epicenter-serve-is-a-program-you-keep-running.md)) |
| Checkpoints | Neither: `git commit` | Documentation ([ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md)) |
| Upgrades | Neither: a version line, `bun install`, a restart | Documentation ([ADR-0953](0953-an-actions-answer-is-data-or-error-and-its-input-is-one-json-schema.md)) |
| Keeping `local/` and `.env` out of Git | Neither, but a skipped step leaks a secret for good | The exception ([ADR-0963](0963-local-ignores-itself-and-serve-refuses-a-dotenv-that-git-would-commit.md)) |

Routines stay because the schedule is a file in the folder. Git reviews a
change to it, a clone restores it, and an agent adds one by writing three
lines, without touching the system scheduler. A crontab line would be one
typed step, but it lives outside the folder, where none of that holds.

`export` refused uncommitted code and links outside the folder, checks Git
alone does not make. Neither failure is silent: the published copy shows
what it holds. The owner makes those checks now.

Rule 3 is about outcomes, not time or state. Serve still holds loaded code,
packages, caches and the routine schedule, as "Specialized guarantees belong
where they are needed" below allows, and routines still run on their clock.

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

The six commitments and the six rules are a design test, not a
requirement to delete every wrapper, guard, or piece of state. A proposed
simplification must name what it removes, what the owner loses, and who
takes on the work. A feature that needs a
different authority, trust boundary, or execution model calls for a new
decision rather than an exception hidden in the implementation.

The [vision](../vision.md) presents the commitments in plain English. The
linked records retain their own decisions and status; this record collects
the reasoning without replacing them.
