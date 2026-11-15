---
name: diagnose
description: Find the cause of broken, throwing, failing, or slow behavior through a reproducible feedback loop, then lock the fix in with a regression test. Use when the user reports such behavior and its cause is not yet established, or explicitly asks to diagnose or debug it.
metadata:
  upstream: mattpocock/skills
  forked: 2026-05-17
---

# Diagnose

Start with the user's symptom and the code path that could produce it. Use repo docs only when they directly shorten the path to a repro.

Scale the procedure to what remains unknown. When the reproduction and the code establish the cause, state that evidence and go to Phase 5; the regression test, the original repro, and Phase 6 still apply. When evidence is ambiguous, contradictory, or timing-sensitive, keep diagnosing until a probe confirms the cause. A plausible explanation does not establish one.

## Phase 1 - Build a feedback loop

The diagnosis depends on this loop. A fast, deterministic, agent-runnable pass/fail signal for the bug gives bisection, hypothesis testing, and instrumentation something to consume; without one, reading code produces guesses. Invest here until you have a loop you trust.

### Ways to construct one

Build the loop where the symptom shows. A symptom someone sees in the UI needs
a loop that observes rendered output: view screenshots of the running app, not
only DOM assertions. A symptom in the desktop app is reproduced in the native
app, since a browser build or mocked bridge can lack the bug. Once the symptom
reproduces there, a lower seam that fails the same way can become the fast
loop. For other symptoms, and for that lower seam, try these in roughly this
order:

1. **Failing test** at whatever seam reaches the bug - unit, integration, e2e.
2. **Curl / HTTP script** against a running dev server.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** (Playwright / Puppeteer) - drives the UI, asserts on DOM/console/network, and captures screenshots to view when the symptom is visual.
5. **Replay a captured trace.** Save a real network request / payload / event log to disk; replay it through the code path in isolation.
6. **Throwaway harness.** Spin up a minimal subset of the system (one service, mocked deps) that exercises the bug code path with a single function call.
7. **Property / fuzz loop.** If the bug is "sometimes wrong output", run 1000 random inputs and look for the failure mode.
8. **Bisection harness.** If the bug appeared between two known states (commit, dataset, version), automate "boot at state X, check, repeat" so you can `git bisect run` it.
9. **Differential loop.** Run the same input through old-version vs new-version (or two configs) and diff outputs.
10. **HITL bash script.** Last resort. If a step needs a person (an OS-owned prompt, physical hardware, or a tool you lack), drive _them_ with `scripts/hitl-loop.template.sh` so the loop is still structured. Captured output feeds back to you.

### Iterate on the loop itself

Treat the loop as a product. Once you have _a_ loop, ask:

- Can I make it faster? (Cache setup, skip unrelated init, narrow the test scope.)
- Can I make the signal sharper? (Assert on the specific symptom, not "didn't crash".)
- Can I make it more deterministic? (Pin time, seed RNG, isolate filesystem, freeze network.)

A slow or flaky loop makes every later probe ambiguous.

### Non-deterministic bugs

The goal is not a clean repro but a **higher reproduction rate**. Loop the trigger 100×, parallelise, add stress, narrow timing windows, inject sleeps. A 50%-flake bug is debuggable; 1% is not - keep raising the rate until it's debuggable.

### When you genuinely cannot build a loop

Stop and say so explicitly. List what you tried. Ask the user for: (a) access to whatever environment reproduces it, (b) a captured artifact (HAR file, log dump, core dump, screen recording with timestamps), or (c) permission to add temporary production instrumentation. Do **not** proceed to hypothesise without a loop.

Do not proceed to Phase 2 until you have a loop you believe in.

## Phase 2 - Reproduce

Run the loop. Watch the bug appear.

Confirm:

- [ ] The loop produces the failure mode the **user** described - not a different failure that happens to be nearby. Wrong bug = wrong fix.
- [ ] The failure is reproducible across multiple runs (or, for non-deterministic bugs, reproducible at a high enough rate to debug against).
- [ ] You have captured the exact symptom (error message, wrong output, slow timing) so later phases can verify the fix actually addresses it.

Do not proceed until you reproduce the bug.

## Phase 3 - Hypothesise

When the reproduction and the code already establish the cause, state it with that evidence and move to Phase 5. Otherwise, write down the causes the evidence makes plausible before testing any of them; holding several at once guards against anchoring on the first idea. List as many as the evidence supports, without padding.

Each hypothesis must be **falsifiable**: state the prediction it makes.

> Format: "If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse."

If you cannot state the prediction, the hypothesis is a vibe - discard or sharpen it.

When several hypotheses remain, share the ranked list with the user and keep testing. They may know of a recent change or an already ruled-out cause that re-ranks it. Sharing it does not wait for a reply.

## Phase 4 - Instrument

Each probe must map to a specific prediction. **Change one variable at a time.**

Tool preference:

1. **Debugger / REPL inspection** if the env supports it. One breakpoint beats ten logs.
2. **Targeted logs** at the boundaries that distinguish hypotheses.
3. Never "log everything and grep".

**Tag every debug log** with a unique prefix, e.g. `[DEBUG-a4f2]`. Cleanup at the end becomes a single grep. Untagged logs survive; tagged logs die.

**Perf branch.** For performance regressions, logs are usually wrong. Instead: establish a baseline measurement (timing harness, `performance.now()`, profiler, query plan), then bisect. Measure first, fix second.

## Phase 5 - Fix + regression test

Write the regression test **before the fix** - but only if there is a **correct seam** for it.

A correct seam is one where the test exercises the **real bug pattern** as it occurs at the call site. If the only available seam is too shallow (single-caller test when the bug needs multiple callers, unit test that can't replicate the chain that triggered the bug), a regression test there gives false confidence.

**If no correct seam exists, that itself is the finding.** Note it. The codebase architecture is preventing the bug from being locked down. Flag this for the next phase.

If a correct seam exists:

1. Turn the minimised repro into a failing test at that seam.
2. Watch it fail.
3. Apply the fix.
4. Watch it pass.
5. Re-run the Phase 1 feedback loop against the original (un-minimised) scenario.

## Phase 6 - Cleanup + post-mortem

Required before declaring done:

- [ ] Original repro no longer reproduces (re-run the Phase 1 loop, in the surface where the symptom appeared)
- [ ] Journeys that share the changed path still behave as before
- [ ] Regression test passes (or absence of seam is documented)
- [ ] All `[DEBUG-...]` instrumentation removed (`grep` the prefix)
- [ ] Throwaway prototypes deleted (or moved to a clearly-marked debug location)
- [ ] The established cause and its evidence are stated in the commit / PR message - so the next debugger learns

If the surface where the symptom appeared could not be exercised, report the fix as unverified there instead of done.

**Then ask: what would have prevented this bug?** If the answer involves architectural change (no good test seam, tangled callers, hidden coupling), capture the concrete follow-up where the team tracks follow-up work. Make the recommendation **after** the fix is in, not before - you have more information now than when you started.
