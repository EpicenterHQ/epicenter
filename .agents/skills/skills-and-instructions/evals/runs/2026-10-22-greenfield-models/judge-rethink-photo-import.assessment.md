# Blind comparison: photo-import API

**Evidence base:** `COMPARISON.md` is the only file in the workspace. There is no `COMPILER-CHECKS.json` and no implementation. This is the photo-import task, so the Svelte syntax checks wouldn't apply anyway. Every claim in all four responses is an unexecuted design proposal.

All four responses reach the same core architecture:
- content-addressed originals
- provenance stored as "sightings"
- a durable record of the person's decisions
- previews and parsing that can be rebuilt
- source identity kept separate from access
- no manager or completion callbacks

So I judged on edge-case reasoning, how well each respects the requirements, and internal consistency, not on the architecture itself.

---

## Pair 1: **B**, confidence low–medium

**Decisive differences**

1. **Overlapping active selections.** Only B covers two live imports that want the same file: "If two active requests want the same (source, locator), the worker reads it once and resolves both lines" and "**Withdrawing one request doesn't stop work another request still wants.**" A covers overlap only one after another (phone, then Takeout). It never says what cancelling does to a file another active import also wants.

2. **The byte-preservation requirement.** Both label a proposal to skip re-reading files. A's version is weaker: "I'd use the fast path only for sources whose fingerprint is verified." A verified source fingerprint shows the drive is the same drive. It says nothing about whether a file was edited in place, which is exactly the risk A itself names. B ties skipping to a per-file guarantee from the platform ("asset id plus a modification revision") and recommends "hash-always for v1". B also states the cost plainly: overlapping files are "re-read even though they aren't re-written."

3. **Reselection matching after a plain browser pick.** Both match re-picked files by name, size and modification time. Only B explains why a wrong match is safe: "Bytes are still hashed, so a wrong match can't corrupt anything. At worst it creates an extra sighting."

4. **Scanning 80,000 files.** B says how listing a large source resumes: "lines appear incrementally and resume from the last enumerated cursor." A doesn't model scanning.

**Where A is stronger**
- It has first-class problem records with next actions ("actions: Array<'retry' | 'reconnect' | 'skip' | 'export-original'>").
- Its access state includes "mismatch" for when the person picks a different folder.
- Its removal proposal is precise: remove "only contents whose only sightings come from this import." B leaves removal across several imports as an open question. Its own example ("Remove 52,000 items imported only by this request?") counts items that may also have sightings from other imports.
- It names real practical problems B skips: Takeout sidecars split across archive parts ("attachments need to be able to accumulate"), and checkpointing the hash state to resume a large copy.

**Concerns**
- A: the "fast path" reasoning above. Also "Problem items retry on the same path" uses "path", a word the model elsewhere says is never a credential. That's cosmetic.
- B: its restart example switches from a "Pixel 8" to "SanDisk Extreme" mid-story, which is a small narrative inconsistency. Its record table lists request lifetime as "until dismissed" without saying what is lost when a request is dismissed. Presumably nothing, since provenance lives on sightings.

Neither response is clearly better. B's advantage is mainly the concurrent-overlap reasoning and its tighter stance on the byte guarantee. A has more operational detail.

---

## Pair 2: **A**, confidence medium

**Decisive differences**

1. **Keeping "what was selected" apart from "what was observed."** A keeps them separate. Intent items have outcomes, and a sighting is written only when bytes are durable: "**The moment of preservation is the sighting commit**." B makes the Sighting a child of the Import that exists before any bytes are read: "Import └─ Sighting … outcome: pending | stored → Original | problem | withdrawn". As a result, B's provenance record can be pending or withdrawn, and "cancel … marks the pending sightings `withdrawn`." It also gains fresh sightings every time the same file is reselected ("creates a new Import with new Sightings"). That mixes the work queue into the provenance record. It is a real modelling flaw: provenance should record what was actually seen.

2. **The byte-preservation requirement.** B's labeled proposal recommends skipping verification **by default**: "trust the match by default for phones and folders." It admits this "breaks 'preserve every distinct byte sequence.'" The label means the change isn't silent, but B recommends weakening an explicit guarantee by default with no evidence about cost. A recommends "reading and hashing by default," argues that "Reading is much cheaper than writing," and offers skipping as an explicit "quick re-scan".

3. **What completion promises.** A is precise: "Complete" means every item is preserved, otherwise the import is "**settled-with-problems** or **withdrawn**, never 'complete'." B says "'Done' means settled with zero problems." By that wording, an import where most items were withdrawn and none had problems would count as "done".

4. **Labeling a requirement it narrows.** A explicitly says that files picked one by one in a browser can't be continued after a restart without reselecting, and that "the UI should say so." B mentions the same limit in its sequence but doesn't label it as a change to the requirement.

**Where B is stronger**
- A concrete diagnostics row: "Original saved ✓ · Preview: unsupported HEIF variant · [Retry preview]".
- It shows an undecodable file during partial success ("Two files are stored but can't be decoded").
- `retry` also resets the intent to `run`.
- Its "Grant" concept correctly treats a path as temporary access.

**Concerns**
- A: "When no screen is mounted, nothing changes" is ambiguous. In context it means the work isn't affected, but it reads as if the work stops. The fingerprint-mismatch prompt ("Treat it as the same source?") lets the person override the check, which is a judgment call. Its progress `state` values (`withdrawn` vs `settled-with-problems`) don't say which wins when an import has both.
- B: the default fast path and the sighting-as-queue-item conflation above.

---

## Consistency across the two pairs

There is a visible, though not proven, structural match across pairs:
- Pair 1 A and Pair 2 B share `library.imports.start` and the identical line `retry(imp.id, { include: ['problems', 'withdrawn'] })`, plus an "explicit undo" proposal with the same wording.
- Pair 1 B and Pair 2 A share the "request/intent" vocabulary and the idea that progress is the comparison between intent and library.

I'm not inferring anything about which version is which.

If those groupings are right, the verdict is consistent: the request/intent style won both pairs. In both cases the winner kept selection lines separate from provenance and recommended hashing every file by default.

The losing style is less consistent with itself. Pair 1 A cleanly separates `ImportItem` from `Sighting` and is close to its opponent. Pair 2 B merges them and recommends the default skip. So its quality varied a lot between repetitions, while the request/intent style held steady. With only two samples, this is a suggestion, not a demonstrated pattern.

**Demonstrated vs. uncertain**
- **Demonstrated** (quoted text): B's sightings with pending/withdrawn outcomes in Pair 2; B's "trust the match by default" in Pair 2; A's fingerprint-based fast path in Pair 1; only Pair 1 B covers concurrent overlapping requests.
- **Uncertain implementation details**, not counted against anyone: directory fsync after rename (no response mentions it), lease timing, and how the raw-metadata attachments are stored.

## Is there a convincing improvement?

- **Pair 2:** modestly convincing. B's issues are conceptual and tied to the requirements, not wording.
- **Pair 1:** a marginal edge only. Each side has things the other lacks, and a different reader could reasonably call it close to a tie.
- **Neither pair** shows a different architecture. The gains are in judgment at the edges.

## What remains untested

Nothing here has been executed. Every response's own open questions still stand:
- whether phone transports (MTP/PTP, PhotoKit) give stable item IDs and revisions
- whether browser `FileSystemHandle` access persists and can be re-granted on each target browser
- hashing throughput on removable USB drives for multi-GB videos, which decides whether any fast path is needed
- atomic rename and flush behaviour on each filesystem
- kill-during-commit fault injection
- re-reading a source of 80,000 files

No execution evidence would change these verdicts at the concept stage. A prototype that measures re-hash cost on overlapping reselection would be the most useful test of the one trade-off where the responses differ in substance.
