//! The shared host's departure round, as plain state.
//!
//! Quitting Epicenter, or restarting it for an account change, ends every page
//! the host serves. Capture and Todos keep unsaved text in their pages, so the
//! host asks each of their windows first and leaves only after every one has
//! agreed or a person has explicitly discarded it. The pages own their drafts;
//! this owns one aggregate round and the native generation of each page.
//!
//! Nothing here touches Tauri. A transition changes window visibility through
//! the [`Windows`] port as part of the transition itself, so every hide, show,
//! and restore is checked against the round, generation, and vote it belongs
//! to at the moment it runs. The caller runs every transition on the one
//! thread that owns the windows. What remains, [`Effect`]s, never touches a
//! window. It depends on `std` alone and compiles as its own test crate:
//!
//! ```text
//! rustc --edition 2021 --test src/departure/machine.rs -o target/departure-machine && target/departure-machine
//! ```

/// The windows that take part. A fixed set: a window that holds no file-backed
/// drafts has nothing to settle, and an app the host does not ship cannot
/// enrol itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Participant {
    Capture,
    Todos,
}

impl Participant {
    pub const ALL: [Self; 2] = [Self::Capture, Self::Todos];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Todos => "todos",
        }
    }

    pub const fn title(self) -> &'static str {
        match self {
            Self::Capture => "Capture",
            Self::Todos => "Todos",
        }
    }

    pub fn from_label(label: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|participant| participant.label() == label)
    }

    const fn index(self) -> usize {
        match self {
            Self::Capture => 0,
            Self::Todos => 1,
        }
    }
}

/// The participant windows as the owning thread sees them, during a
/// transition. Every call is synchronous.
pub trait Windows {
    fn exists(&self, participant: Participant) -> bool;
    /// `None` when the window is missing or its visibility cannot be read.
    fn visible(&self, participant: Participant) -> Option<bool>;
    /// Ask the window to hide. True when the request was applied without
    /// error, which is not yet confirmation that it is hidden.
    fn hide(&mut self, participant: Participant) -> bool;
    /// Show the window, and focus it when `focus` is set.
    fn show(&mut self, participant: Participant, focus: bool);
}

/// What one page has said in the current round.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vote {
    /// Not answered, or asked again by a repeated Quit.
    None,
    /// Settling, or showing its own question to the person.
    Asking,
    /// Settled, or the person chose to discard in the page.
    Ready,
    /// The person discarded it in the native dialog. Its window is hidden and
    /// stays hidden until the round ends without leaving.
    Discarded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    Asking,
    Ready,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhaseName {
    Idle,
    Collecting,
    Granted,
    Leaving,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentName {
    Quit,
    Restart,
}

/// The answer to AppKit's `applicationShouldTerminate:`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminateReply {
    /// Terminate as AppKit would without the round: no page holds a draft.
    Now,
    /// Refuse, and start nothing.
    Cancel,
    /// Refuse, then request an ordinary exit, which runs the round.
    CancelAndQuit,
}

/// What a page reads. `version` rises with every change, so a page can drop
/// a reply that an earlier read overtook.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    pub version: u64,
    pub generation: u64,
    pub phase: PhaseName,
    pub round: Option<u64>,
    pub intent: Option<IntentName>,
    pub vote: Option<Vote>,
}

/// Why the round exists. A quit carries the exit code to use; a restart
/// carries the Bun generation and request that asked for it, which is the
/// only identity that can finish or abort the grant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Intent {
    Quit { code: i32 },
    Restart { sidecar: u64, request_id: String },
}

impl Intent {
    const fn name(&self) -> IntentName {
        match self {
            Self::Quit { .. } => IntentName::Quit,
            Self::Restart { .. } => IntentName::Restart,
        }
    }
}

/// Work for the caller after the transition. None of it touches a window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    /// Tell this page its status changed. Carries nothing: the page reads.
    Nudge(Participant),
    /// Ask the person about silent pages after the grace period.
    ArmFallback {
        round: u64,
        arm: u64,
    },
    /// The one terminal answer to a restart preparation.
    Reply {
        sidecar: u64,
        request_id: String,
        result: Result<(), String>,
    },
    Exit(i32),
    Restart,
    /// Something the person must see.
    Report(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Member {
    participant: Participant,
    generation: u64,
    vote: Vote,
    /// Whether the window was visible before this round first showed or hid
    /// it. Set before the change is attempted, so a failed change is undone
    /// too. A round that ends without leaving puts the window back to this.
    original: Option<bool>,
}

#[derive(Debug)]
enum Phase {
    Idle,
    Collecting {
        round: u64,
        intent: Intent,
        members: Vec<Member>,
        arm: u64,
        dialog_open: bool,
    },
    Granted {
        round: u64,
        sidecar: u64,
        request_id: String,
        members: Vec<Member>,
    },
    Leaving {
        round: u64,
        intent: IntentName,
        members: Vec<Member>,
    },
}

const BUSY: &str = "Epicenter is already quitting or restarting.";
const HIDE_FAILED: &str =
    "Epicenter could not hide a window before leaving, so nothing was discarded.";
const RESTARTING: &str =
    "Epicenter is restarting to change accounts, so it cannot quit now. If it stays open, quit again.";

#[derive(Debug)]
pub struct Machine {
    version: u64,
    next_round: u64,
    generations: [u64; 2],
    phase: Phase,
}

impl Default for Machine {
    fn default() -> Self {
        Self {
            version: 1,
            next_round: 1,
            generations: [0; 2],
            phase: Phase::Idle,
        }
    }
}

impl Machine {
    pub fn status(&self, participant: Participant) -> Status {
        let generation = self.generations[participant.index()];
        let (phase, round, intent, members) = match &self.phase {
            Phase::Idle => {
                return Status {
                    version: self.version,
                    generation,
                    phase: PhaseName::Idle,
                    round: None,
                    intent: None,
                    vote: None,
                }
            }
            Phase::Collecting {
                round,
                intent,
                members,
                ..
            } => (PhaseName::Collecting, *round, intent.name(), members),
            Phase::Granted { round, members, .. } => {
                (PhaseName::Granted, *round, IntentName::Restart, members)
            }
            Phase::Leaving {
                round,
                intent,
                members,
            } => (PhaseName::Leaving, *round, *intent, members),
        };
        let vote = members
            .iter()
            .find(|member| member.participant == participant && member.generation == generation)
            .map_or(Vote::None, |member| member.vote);
        Status {
            version: self.version,
            generation,
            phase,
            round: Some(round),
            intent: Some(intent),
            vote: Some(vote),
        }
    }

    /// The intent of the round in progress, if any.
    pub fn intent(&self) -> Option<IntentName> {
        match &self.phase {
            Phase::Idle => None,
            Phase::Collecting { intent, .. } => Some(intent.name()),
            Phase::Granted { .. } => Some(IntentName::Restart),
            Phase::Leaving { intent, .. } => Some(*intent),
        }
    }

    /// Whether a participant window may be shown or focused. Ordinary pages
    /// may be shown while a round collects, so they can answer; a discarded
    /// page may not, and nothing may be shown once leaving is agreed.
    pub fn may_reveal(&self, participant: Participant) -> bool {
        match &self.phase {
            Phase::Idle => true,
            Phase::Collecting { members, .. } => !members
                .iter()
                .any(|member| member.participant == participant && member.vote == Vote::Discarded),
            Phase::Granted { .. } | Phase::Leaving { .. } => false,
        }
    }

    /// Whether a participant window may be created. The round's members are
    /// fixed when it starts, so a new one waits until it ends.
    pub fn may_create(&self) -> bool {
        matches!(self.phase, Phase::Idle)
    }

    /// AppKit asks whether it may terminate the process: the Dock's Quit, the
    /// app menu's Quit, logout, and every other `terminate:` caller. Only
    /// when no participant window exists is there nothing to ask; otherwise
    /// the round must run first, through the same exit request as any quit.
    pub fn terminate_reply(&self, windows: &dyn Windows) -> TerminateReply {
        match &self.phase {
            // Tauri's own exit is already stopping the loop. It never calls
            // `terminate:`, and a second exit request is not needed.
            Phase::Leaving { .. } => TerminateReply::Cancel,
            Phase::Idle if existing(windows).is_empty() => TerminateReply::Now,
            Phase::Idle | Phase::Collecting { .. } | Phase::Granted { .. } => {
                TerminateReply::CancelAndQuit
            }
        }
    }

    /// A page in this participant's window is starting, or the window was
    /// destroyed. Either way the page that answered before is gone.
    pub fn page_replaced(
        &mut self,
        participant: Participant,
        windows: &mut dyn Windows,
    ) -> Vec<Effect> {
        self.generations[participant.index()] += 1;
        self.changed();
        let intent = match &self.phase {
            Phase::Collecting {
                members, intent, ..
            } if members
                .iter()
                .any(|member| member.participant == participant) =>
            {
                intent.name()
            }
            // While granted only this page's identity changes. Its reload
            // reads `granted`, so it stays fenced, and the other pages are
            // untouched.
            _ => return Vec::new(),
        };
        // A member that reloads has dropped whatever it was settling, and the
        // round cannot know what the new page holds.
        let reason = format!(
            "{} reloaded or closed while Epicenter was asking it",
            participant.title()
        );
        match intent {
            IntentName::Restart => self.end_collecting(
                windows,
                Some(format!("{reason}, so the restart was cancelled.")),
                None,
            ),
            IntentName::Quit => self.end_collecting(
                windows,
                None,
                Some(format!(
                    "{reason}, so Epicenter stayed open. Quit again to leave."
                )),
            ),
        }
    }

    /// The page answers for the generation and round it read.
    pub fn answer(
        &mut self,
        participant: Participant,
        generation: u64,
        round: u64,
        answer: Answer,
        windows: &mut dyn Windows,
    ) -> Vec<Effect> {
        if generation != self.generations[participant.index()] {
            return Vec::new();
        }
        let Phase::Collecting {
            round: current,
            members,
            ..
        } = &mut self.phase
        else {
            return Vec::new();
        };
        if *current != round {
            return Vec::new();
        }
        let Some(member) = members
            .iter_mut()
            .find(|member| member.participant == participant && member.generation == generation)
        else {
            return Vec::new();
        };
        match (answer, member.vote) {
            // The person's native discard stands; a page that wakes after it
            // cannot ask the person anything from a hidden window.
            (_, Vote::Discarded) => Vec::new(),
            (Answer::Cancel, _) => self.end_collecting(
                windows,
                Some(format!("{} kept Epicenter open.", participant.title())),
                None,
            ),
            (Answer::Asking, Vote::None) => {
                member.vote = Vote::Asking;
                // A page deciding may need to ask the person, so its window
                // is shown even if the person had closed it.
                reveal(member, windows);
                self.changed();
                Vec::new()
            }
            (Answer::Asking, _) | (Answer::Ready, Vote::Ready) => Vec::new(),
            (Answer::Ready, _) => {
                member.vote = Vote::Ready;
                self.changed();
                self.complete(windows)
            }
        }
    }

    /// The process was asked to exit with `code`. Returns whether to prevent
    /// that exit, and what to do instead.
    pub fn request_quit(&mut self, code: i32, windows: &mut dyn Windows) -> (bool, Vec<Effect>) {
        match &self.phase {
            Phase::Leaving { .. } => (false, Vec::new()),
            // The grant is not withdrawn: Bun finishes or aborts it.
            Phase::Granted { .. } => (true, vec![Effect::Report(RESTARTING.into())]),
            // A quit or a restart round alike. Its intent is kept; nothing
            // merges or queues behind it.
            Phase::Collecting { .. } => (true, self.reissue(windows)),
            Phase::Idle => {
                let existing = existing(windows);
                if existing.is_empty() {
                    (false, Vec::new())
                } else {
                    (true, self.begin(Intent::Quit { code }, &existing))
                }
            }
        }
    }

    /// Bun asks to restart for an account change. Every path ends in exactly
    /// one [`Effect::Reply`] for this request, unless the generation retires
    /// first and nobody is left to read it.
    pub fn prepare_restart(
        &mut self,
        sidecar: u64,
        request_id: String,
        windows: &mut dyn Windows,
    ) -> Vec<Effect> {
        if !matches!(self.phase, Phase::Idle) {
            return vec![Effect::Reply {
                sidecar,
                request_id,
                result: Err(BUSY.into()),
            }];
        }
        let existing = existing(windows);
        if existing.is_empty() {
            let round = self.take_round();
            self.phase = Phase::Granted {
                round,
                sidecar,
                request_id: request_id.clone(),
                members: Vec::new(),
            };
            self.changed();
            return vec![Effect::Reply {
                sidecar,
                request_id,
                result: Ok(()),
            }];
        }
        self.begin(
            Intent::Restart {
                sidecar,
                request_id,
            },
            &existing,
        )
    }

    /// Bun withdrew its preparation. Only a round still collecting can be
    /// withdrawn; a grant is released by [`Self::relaunch_abort`] instead.
    pub fn prepare_cancel(
        &mut self,
        sidecar: u64,
        request_id: &str,
        windows: &mut dyn Windows,
    ) -> Vec<Effect> {
        if self.collecting_restart(sidecar, request_id) {
            self.end_collecting(windows, Some("The restart was cancelled.".into()), None)
        } else {
            Vec::new()
        }
    }

    /// Bun releases its grant without restarting.
    pub fn relaunch_abort(
        &mut self,
        sidecar: u64,
        request_id: &str,
        windows: &mut dyn Windows,
    ) -> Vec<Effect> {
        if self.granted_to(sidecar, request_id) {
            self.release_grant(windows)
        } else {
            Vec::new()
        }
    }

    /// Bun finishes its grant. The caller restarts the process.
    pub fn relaunch(&mut self, sidecar: u64, request_id: &str) -> Vec<Effect> {
        if !self.granted_to(sidecar, request_id) {
            return Vec::new();
        }
        let Phase::Granted { round, members, .. } = std::mem::replace(&mut self.phase, Phase::Idle)
        else {
            unreachable!("granted_to checked the phase");
        };
        self.phase = Phase::Leaving {
            round,
            intent: IntentName::Restart,
            members,
        };
        self.changed();
        vec![Effect::Restart]
    }

    /// A Bun generation stopped. Whatever it was preparing or holding ends, and
    /// every preserved page resumes. Nobody is left to read a reply.
    pub fn retire_sidecar(&mut self, sidecar: u64, windows: &mut dyn Windows) -> Vec<Effect> {
        match &self.phase {
            Phase::Collecting {
                intent: Intent::Restart { sidecar: owner, .. },
                ..
            } if *owner == sidecar => self.end_collecting(windows, None, None),
            Phase::Granted { sidecar: owner, .. } if *owner == sidecar => {
                self.release_grant(windows)
            }
            _ => Vec::new(),
        }
    }

    /// The grace period passed. Returns the silent pages, at the generations
    /// the person will be asked about, and marks the one dialog open.
    pub fn fallback_due(&mut self, round: u64, arm: u64) -> Vec<(Participant, u64)> {
        let Phase::Collecting {
            round: current,
            members,
            arm: current_arm,
            dialog_open,
            ..
        } = &mut self.phase
        else {
            return Vec::new();
        };
        if *current != round || *current_arm != arm || *dialog_open {
            return Vec::new();
        }
        let silent: Vec<_> = members
            .iter()
            .filter(|member| member.vote == Vote::None)
            .map(|member| (member.participant, member.generation))
            .collect();
        if !silent.is_empty() {
            *dialog_open = true;
        }
        silent
    }

    /// The person chose to keep Epicenter open in the native dialog.
    pub fn fallback_keep(&mut self, round: u64, windows: &mut dyn Windows) -> Vec<Effect> {
        match &self.phase {
            Phase::Collecting { round: current, .. } if *current == round => self.end_collecting(
                windows,
                Some("The person kept Epicenter open.".into()),
                None,
            ),
            _ => Vec::new(),
        }
    }

    /// The person chose to discard the pages they were asked about. Each one
    /// still at the listed generation and still undecided is hidden, and it
    /// counts as discarded only once its window confirmed it is hidden. A
    /// decision for an earlier round touches nothing.
    pub fn discard(
        &mut self,
        round: u64,
        listed: &[(Participant, u64)],
        windows: &mut dyn Windows,
    ) -> Vec<Effect> {
        let Phase::Collecting {
            round: current,
            members,
            dialog_open,
            ..
        } = &mut self.phase
        else {
            return Vec::new();
        };
        if *current != round {
            return Vec::new();
        }
        *dialog_open = false;
        let mut discarded = Vec::new();
        let mut confirmed = true;
        for (participant, generation) in listed {
            let Some(member) = members.iter_mut().find(|member| {
                member.participant == *participant
                    && member.generation == *generation
                    && matches!(member.vote, Vote::None | Vote::Asking)
            }) else {
                continue;
            };
            if !conceal(member, windows) {
                confirmed = false;
                break;
            }
            member.vote = Vote::Discarded;
            discarded.push(member.participant);
        }
        if !confirmed {
            return self.end_collecting(
                windows,
                Some(HIDE_FAILED.into()),
                Some(HIDE_FAILED.into()),
            );
        }
        if !discarded.is_empty() {
            self.changed();
        }
        let mut effects: Vec<_> = discarded.into_iter().map(Effect::Nudge).collect();
        effects.extend(self.complete(windows));
        if let Phase::Collecting {
            round,
            members,
            arm,
            ..
        } = &mut self.phase
        {
            if members.iter().any(|member| member.vote == Vote::None) {
                *arm += 1;
                effects.push(Effect::ArmFallback {
                    round: *round,
                    arm: *arm,
                });
            }
        }
        effects
    }

    fn changed(&mut self) {
        self.version += 1;
    }

    fn take_round(&mut self) -> u64 {
        let round = self.next_round;
        self.next_round += 1;
        round
    }

    /// Start a round over the windows that exist now. No window is shown: a
    /// page is shown when it says it is deciding, or when the person asks
    /// again.
    fn begin(&mut self, intent: Intent, existing: &[Participant]) -> Vec<Effect> {
        let round = self.take_round();
        let members: Vec<Member> = existing
            .iter()
            .map(|participant| Member {
                participant: *participant,
                generation: self.generations[participant.index()],
                vote: Vote::None,
                original: None,
            })
            .collect();
        let mut effects: Vec<_> = members
            .iter()
            .map(|member| Effect::Nudge(member.participant))
            .collect();
        effects.push(Effect::ArmFallback { round, arm: 1 });
        self.phase = Phase::Collecting {
            round,
            intent,
            members,
            arm: 1,
            dialog_open: false,
        };
        self.changed();
        effects
    }

    /// The person asked again during a round. Pages still deciding are asked
    /// once more and shown, so one that hung after `asking` falls to the
    /// native dialog if it stays silent, while a live page only re-sends
    /// `asking` and shows its own prompt once.
    fn reissue(&mut self, windows: &mut dyn Windows) -> Vec<Effect> {
        let Phase::Collecting {
            round,
            members,
            arm,
            dialog_open,
            ..
        } = &mut self.phase
        else {
            return Vec::new();
        };
        let mut changed = false;
        let mut effects = Vec::new();
        for member in members.iter_mut() {
            if member.vote == Vote::Asking {
                member.vote = Vote::None;
                changed = true;
            }
            if member.vote == Vote::None {
                reveal(member, windows);
                effects.push(Effect::Nudge(member.participant));
            }
        }
        *arm += 1;
        if !*dialog_open {
            effects.push(Effect::ArmFallback {
                round: *round,
                arm: *arm,
            });
        }
        if changed {
            self.changed();
        }
        effects
    }

    /// Every member agreed: leave for a quit; for a restart, hide every
    /// member window, each confirmed, and only then grant.
    fn complete(&mut self, windows: &mut dyn Windows) -> Vec<Effect> {
        let Phase::Collecting {
            intent, members, ..
        } = &mut self.phase
        else {
            return Vec::new();
        };
        if !members
            .iter()
            .all(|member| matches!(member.vote, Vote::Ready | Vote::Discarded))
        {
            return Vec::new();
        }
        if let Intent::Restart { .. } = intent {
            let mut hidden = true;
            for member in members.iter_mut() {
                if !conceal(member, windows) {
                    hidden = false;
                    break;
                }
            }
            if !hidden {
                return self.end_collecting(
                    windows,
                    Some(HIDE_FAILED.into()),
                    Some(HIDE_FAILED.into()),
                );
            }
        }
        let Phase::Collecting {
            round,
            intent,
            members,
            ..
        } = std::mem::replace(&mut self.phase, Phase::Idle)
        else {
            unreachable!("checked above");
        };
        self.changed();
        match intent {
            Intent::Quit { code } => {
                self.phase = Phase::Leaving {
                    round,
                    intent: IntentName::Quit,
                    members,
                };
                vec![Effect::Exit(code)]
            }
            Intent::Restart {
                sidecar,
                request_id,
            } => {
                let mut effects = vec![Effect::Reply {
                    sidecar,
                    request_id: request_id.clone(),
                    result: Ok(()),
                }];
                effects.extend(
                    members
                        .iter()
                        .map(|member| Effect::Nudge(member.participant)),
                );
                self.phase = Phase::Granted {
                    round,
                    sidecar,
                    request_id,
                    members,
                };
                effects
            }
        }
    }

    /// Back to idle without leaving: every window this round showed or hid is
    /// put back as the round found it, a restart gets its one error, and
    /// every member is told.
    fn end_collecting(
        &mut self,
        windows: &mut dyn Windows,
        reply: Option<String>,
        report: Option<String>,
    ) -> Vec<Effect> {
        let Phase::Collecting {
            intent, members, ..
        } = std::mem::replace(&mut self.phase, Phase::Idle)
        else {
            return Vec::new();
        };
        self.changed();
        restore(&members, windows);
        let mut effects = Vec::new();
        if let (
            Intent::Restart {
                sidecar,
                request_id,
            },
            Some(message),
        ) = (intent, reply)
        {
            effects.push(Effect::Reply {
                sidecar,
                request_id,
                result: Err(message),
            });
        }
        if let Some(report) = report {
            effects.push(Effect::Report(report));
        }
        effects.extend(
            members
                .iter()
                .map(|member| Effect::Nudge(member.participant)),
        );
        effects
    }

    fn release_grant(&mut self, windows: &mut dyn Windows) -> Vec<Effect> {
        let Phase::Granted { members, .. } = std::mem::replace(&mut self.phase, Phase::Idle) else {
            return Vec::new();
        };
        self.changed();
        restore(&members, windows);
        members
            .iter()
            .map(|member| Effect::Nudge(member.participant))
            .collect()
    }

    fn collecting_restart(&self, sidecar: u64, request_id: &str) -> bool {
        matches!(
            &self.phase,
            Phase::Collecting { intent: Intent::Restart { sidecar: owner, request_id: id }, .. }
                if *owner == sidecar && id == request_id
        )
    }

    fn granted_to(&self, sidecar: u64, request_id: &str) -> bool {
        matches!(
            &self.phase,
            Phase::Granted { sidecar: owner, request_id: id, .. }
                if *owner == sidecar && id == request_id
        )
    }
}

fn existing(windows: &dyn Windows) -> Vec<Participant> {
    Participant::ALL
        .into_iter()
        .filter(|participant| windows.exists(*participant))
        .collect()
}

/// Remember the visibility the round found, before its first change. An
/// unreadable visibility counts as visible, so ending the round shows the
/// window rather than losing it.
fn remember(member: &mut Member, windows: &dyn Windows) {
    if member.original.is_none() {
        member.original = Some(windows.visible(member.participant).unwrap_or(true));
    }
}

/// Show a member's window so its page can ask the person.
fn reveal(member: &mut Member, windows: &mut dyn Windows) {
    if member.vote == Vote::Discarded || !windows.exists(member.participant) {
        return;
    }
    remember(member, windows);
    windows.show(member.participant, true);
}

/// Hide a member's window and confirm it. A window that no longer exists is
/// hidden already.
fn conceal(member: &mut Member, windows: &mut dyn Windows) -> bool {
    let participant = member.participant;
    if !windows.exists(participant) {
        return true;
    }
    remember(member, windows);
    windows.hide(participant) && windows.visible(participant) == Some(false)
}

/// Put every window the round changed back as the round found it, shown or
/// hidden.
fn restore(members: &[Member], windows: &mut dyn Windows) {
    for member in members {
        let Some(original) = member.original else {
            continue;
        };
        if !windows.exists(member.participant) {
            continue;
        }
        if original {
            windows.show(member.participant, false);
        } else {
            windows.hide(member.participant);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Participant::{Capture, Todos};

    /// Two windows the tests can make refuse to hide, or go blind after a
    /// hide, and whose every change is logged.
    #[derive(Default)]
    struct Fake {
        exists: [bool; 2],
        visible: [bool; 2],
        refuse_hide: [bool; 2],
        blind_after_hide: [bool; 2],
        hidden_once: [bool; 2],
        log: Vec<String>,
    }

    impl Fake {
        fn new(capture_visible: bool, todos_visible: bool) -> Self {
            Self {
                exists: [true, true],
                visible: [capture_visible, todos_visible],
                ..Self::default()
            }
        }

        fn none() -> Self {
            Self::default()
        }

        fn is_visible(&self, participant: Participant) -> bool {
            self.visible[participant.index()]
        }
    }

    impl Windows for Fake {
        fn exists(&self, participant: Participant) -> bool {
            self.exists[participant.index()]
        }

        fn visible(&self, participant: Participant) -> Option<bool> {
            let index = participant.index();
            if !self.exists[index] || (self.blind_after_hide[index] && self.hidden_once[index]) {
                return None;
            }
            Some(self.visible[index])
        }

        fn hide(&mut self, participant: Participant) -> bool {
            let index = participant.index();
            self.log.push(format!("hide {}", participant.label()));
            if self.refuse_hide[index] {
                return false;
            }
            self.visible[index] = false;
            self.hidden_once[index] = true;
            true
        }

        fn show(&mut self, participant: Participant, focus: bool) {
            let verb = if focus { "focus" } else { "show" };
            self.log.push(format!("{verb} {}", participant.label()));
            self.visible[participant.index()] = true;
        }
    }

    fn loaded() -> Machine {
        let mut machine = Machine::default();
        let mut windows = Fake::new(true, true);
        machine.page_replaced(Capture, &mut windows);
        machine.page_replaced(Todos, &mut windows);
        machine
    }

    fn replies(effects: &[Effect]) -> Vec<&Result<(), String>> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Reply { result, .. } => Some(result),
                _ => None,
            })
            .collect()
    }

    fn reports(effects: &[Effect]) -> usize {
        effects
            .iter()
            .filter(|effect| matches!(effect, Effect::Report(_)))
            .count()
    }

    fn round_of(machine: &Machine) -> u64 {
        machine.status(Capture).round.unwrap()
    }

    /// Collect both pages for a restart and grant it.
    fn granted(machine: &mut Machine, windows: &mut Fake, sidecar: u64, request_id: &str) -> u64 {
        machine.prepare_restart(sidecar, request_id.into(), windows);
        let round = round_of(machine);
        machine.answer(Capture, 1, round, Answer::Ready, windows);
        let effects = machine.answer(Todos, 1, round, Answer::Ready, windows);
        assert_eq!(replies(&effects), vec![&Ok(())]);
        round
    }

    #[test]
    fn only_the_fixed_windows_take_part() {
        assert_eq!(Participant::from_label("capture"), Some(Capture));
        assert_eq!(Participant::from_label("todos"), Some(Todos));
        for label in ["home", "whispering", "mail", "folders", "app-capture", "Capture", ""] {
            assert_eq!(Participant::from_label(label), None, "{label}");
        }
    }

    #[test]
    fn idle_status_has_no_round_and_versions_only_rise_on_change() {
        let machine = loaded();
        let status = machine.status(Capture);
        assert_eq!(status.phase, PhaseName::Idle);
        assert_eq!(
            (status.round, status.intent, status.vote),
            (None, None, None)
        );
        assert_eq!(status.generation, 1);

        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        let before = machine.status(Capture).version;
        machine.request_quit(0, &mut windows);
        let collecting = machine.status(Capture).version;
        assert!(collecting > before);
        let round = round_of(&machine);
        machine.answer(Capture, 1, round, Answer::Asking, &mut windows);
        let asking = machine.status(Capture).version;
        assert!(asking > collecting);
        // Saying the same thing again changes nothing.
        machine.answer(Capture, 1, round, Answer::Asking, &mut windows);
        assert_eq!(machine.status(Capture).version, asking);
    }

    #[test]
    fn appkit_termination_is_refused_until_the_round_has_agreed() {
        let mut machine = loaded();
        // No participant window: AppKit terminates as it always has.
        assert_eq!(machine.terminate_reply(&Fake::none()), TerminateReply::Now);

        // A participant window: refuse, then the exit request starts a round.
        let mut windows = Fake::new(true, false);
        assert_eq!(
            machine.terminate_reply(&windows),
            TerminateReply::CancelAndQuit
        );
        let (prevent, _) = machine.request_quit(0, &mut windows);
        assert!(prevent);
        let round = round_of(&machine);
        assert_eq!(machine.status(Capture).intent, Some(IntentName::Quit));

        // Quit again from the Dock while it collects: refused, asked again.
        assert_eq!(
            machine.terminate_reply(&windows),
            TerminateReply::CancelAndQuit
        );
        machine.answer(Capture, 1, round, Answer::Cancel, &mut windows);
        assert_eq!(machine.status(Capture).phase, PhaseName::Idle);

        // The next request is agreed by both pages, and leaves once.
        assert_eq!(
            machine.terminate_reply(&windows),
            TerminateReply::CancelAndQuit
        );
        machine.request_quit(0, &mut windows);
        let round = round_of(&machine);
        machine.answer(Capture, 1, round, Answer::Ready, &mut windows);
        assert_eq!(
            machine.answer(Todos, 1, round, Answer::Ready, &mut windows),
            vec![Effect::Exit(0)]
        );
        // While leaving, AppKit is refused and nothing asks to exit again.
        assert_eq!(machine.terminate_reply(&windows), TerminateReply::Cancel);
    }

    #[test]
    fn appkit_termination_during_a_restart_is_refused_and_asks_again() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.prepare_restart(1, "sign-out".into(), &mut windows);
        assert_eq!(
            machine.terminate_reply(&windows),
            TerminateReply::CancelAndQuit
        );
        // The exit request then asks the same restart round again.
        let (prevent, effects) = machine.request_quit(0, &mut windows);
        assert!(prevent);
        assert!(effects.contains(&Effect::Nudge(Capture)));
        assert_eq!(machine.status(Capture).intent, Some(IntentName::Restart));

        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        granted(&mut machine, &mut windows, 2, "p");
        // Granted is never `Now`, even when no window would be asked.
        assert_eq!(
            machine.terminate_reply(&Fake::none()),
            TerminateReply::CancelAndQuit
        );
        assert_eq!(
            machine.request_quit(0, &mut windows),
            (true, vec![Effect::Report(RESTARTING.into())])
        );
    }

    #[test]
    fn quit_without_participant_windows_exits_at_once() {
        let mut machine = loaded();
        assert_eq!(
            machine.request_quit(0, &mut Fake::none()),
            (false, Vec::new())
        );
        assert_eq!(machine.status(Capture).phase, PhaseName::Idle);
    }

    #[test]
    fn quit_asks_every_existing_window_without_showing_any() {
        let mut machine = loaded();
        let mut windows = Fake::new(false, true);
        let (prevent, effects) = machine.request_quit(3, &mut windows);
        assert!(prevent);
        let round = round_of(&machine);
        assert_eq!(
            effects,
            vec![
                Effect::Nudge(Capture),
                Effect::Nudge(Todos),
                Effect::ArmFallback { round, arm: 1 },
            ]
        );
        assert!(windows.log.is_empty(), "{:?}", windows.log);
        assert!(!machine.may_create());
        assert!(machine
            .answer(Capture, 1, round, Answer::Ready, &mut windows)
            .is_empty());
        assert_eq!(machine.status(Capture).vote, Some(Vote::Ready));
        assert_eq!(
            machine.answer(Todos, 1, round, Answer::Ready, &mut windows),
            vec![Effect::Exit(3)]
        );
        assert_eq!(machine.status(Todos).phase, PhaseName::Leaving);
        assert!(windows.log.is_empty(), "nothing flashed: {:?}", windows.log);
        // Exiting raises ExitRequested again, which now passes.
        assert_eq!(machine.request_quit(3, &mut windows), (false, Vec::new()));
        assert!(!machine.may_reveal(Capture));
    }

    #[test]
    fn a_deciding_page_is_shown_and_a_cancel_hides_it_again() {
        let mut machine = loaded();
        let mut windows = Fake::new(false, true);
        machine.request_quit(0, &mut windows);
        let round = round_of(&machine);
        machine.answer(Capture, 1, round, Answer::Asking, &mut windows);
        assert!(windows.is_visible(Capture), "a hidden page can still ask");
        assert_eq!(windows.log, ["focus capture"]);
        machine.answer(Capture, 1, round, Answer::Cancel, &mut windows);
        assert!(!windows.is_visible(Capture), "the person had closed it");
        assert!(windows.is_visible(Todos));
        assert_eq!(windows.log, ["focus capture", "hide capture"]);
    }

    #[test]
    fn stale_generations_and_rounds_change_nothing() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.request_quit(0, &mut windows);
        let round = round_of(&machine);
        let version = machine.status(Capture).version;
        for (generation, answer_round) in [(0, round), (2, round), (1, round + 1), (1, round - 1)] {
            assert!(machine
                .answer(
                    Capture,
                    generation,
                    answer_round,
                    Answer::Cancel,
                    &mut windows
                )
                .is_empty());
        }
        assert_eq!(machine.status(Capture).version, version);
        assert_eq!(machine.status(Capture).phase, PhaseName::Collecting);
    }

    #[test]
    fn cancel_after_the_other_page_was_ready_resumes_both() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.request_quit(0, &mut windows);
        let round = round_of(&machine);
        machine.answer(Capture, 1, round, Answer::Ready, &mut windows);
        let effects = machine.answer(Todos, 1, round, Answer::Cancel, &mut windows);
        assert_eq!(effects, vec![Effect::Nudge(Capture), Effect::Nudge(Todos)]);
        assert_eq!(machine.status(Capture).phase, PhaseName::Idle);
        assert!(machine.may_create());
    }

    #[test]
    fn a_status_read_is_authoritative_whatever_the_nudges_did() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        let idle = machine.status(Todos);
        machine.request_quit(0, &mut windows);
        let collecting = machine.status(Todos);
        assert_eq!(collecting.phase, PhaseName::Collecting);
        assert!(collecting.version > idle.version);
        let round = collecting.round.unwrap();
        machine.answer(Capture, 1, round, Answer::Cancel, &mut windows);
        let after = machine.status(Todos);
        assert_eq!(after.phase, PhaseName::Idle);
        assert!(after.version > collecting.version);
    }

    #[test]
    fn repeated_quit_asks_again_without_duplicating_and_reaches_the_fallback() {
        let mut machine = loaded();
        let mut windows = Fake::new(false, true);
        machine.request_quit(0, &mut windows);
        let round = round_of(&machine);
        machine.answer(Capture, 1, round, Answer::Asking, &mut windows);
        machine.answer(Todos, 1, round, Answer::Ready, &mut windows);
        let (prevent, effects) = machine.request_quit(0, &mut windows);
        assert!(prevent);
        assert_eq!(
            effects,
            vec![
                Effect::Nudge(Capture),
                Effect::ArmFallback { round, arm: 2 }
            ]
        );
        assert_eq!(round_of(&machine), round);
        assert_eq!(machine.status(Capture).vote, Some(Vote::None));
        assert!(machine.fallback_due(round, 1).is_empty());
        assert_eq!(machine.fallback_due(round, 2), vec![(Capture, 1)]);
        // One dialog at a time, however often Quit is pressed.
        let (_, effects) = machine.request_quit(0, &mut windows);
        assert!(!effects
            .iter()
            .any(|effect| matches!(effect, Effect::ArmFallback { .. })));
        assert!(machine.fallback_due(round, 3).is_empty());
    }

    #[test]
    fn a_live_page_reacknowledges_and_is_not_offered_for_discard() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, false);
        windows.exists = [true, false];
        machine.request_quit(0, &mut windows);
        let round = round_of(&machine);
        machine.answer(Capture, 1, round, Answer::Asking, &mut windows);
        machine.request_quit(0, &mut windows);
        machine.answer(Capture, 1, round, Answer::Asking, &mut windows);
        assert!(machine.fallback_due(round, 2).is_empty());
    }

    #[test]
    fn repeated_quit_during_a_restart_reissues_the_same_restart_round() {
        // Sign-out is collecting, Capture said `asking` and then hung.
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.prepare_restart(4, "sign-out".into(), &mut windows);
        let round = round_of(&machine);
        machine.answer(Capture, 1, round, Answer::Asking, &mut windows);
        machine.answer(Todos, 1, round, Answer::Ready, &mut windows);
        assert!(
            machine.fallback_due(round, 1).is_empty(),
            "nobody is silent yet"
        );

        let version = machine.status(Capture).version;
        let (prevent, effects) = machine.request_quit(0, &mut windows);
        assert!(prevent);
        assert_eq!(
            effects,
            vec![
                Effect::Nudge(Capture),
                Effect::ArmFallback { round, arm: 2 }
            ]
        );
        let status = machine.status(Capture);
        assert_eq!(status.round, Some(round));
        assert_eq!(status.intent, Some(IntentName::Restart));
        assert_eq!(status.vote, Some(Vote::None));
        assert!(status.version > version);
        // The hung page reaches the native dialog, which offers a restart.
        assert_eq!(machine.fallback_due(round, 2), vec![(Capture, 1)]);
        assert_eq!(machine.intent(), Some(IntentName::Restart));
        let effects = machine.discard(round, &[(Capture, 1)], &mut windows);
        assert_eq!(replies(&effects), vec![&Ok(())]);
        assert!(!effects
            .iter()
            .any(|effect| matches!(effect, Effect::Exit(_))));
        assert_eq!(machine.status(Capture).phase, PhaseName::Granted);
    }

    #[test]
    fn a_live_page_in_a_restart_keeps_its_own_prompt_after_a_repeated_quit() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.prepare_restart(4, "sign-out".into(), &mut windows);
        let round = round_of(&machine);
        machine.answer(Capture, 1, round, Answer::Asking, &mut windows);
        machine.answer(Todos, 1, round, Answer::Ready, &mut windows);
        machine.request_quit(0, &mut windows);
        // The page re-sends `asking`; its own prompt is still the one shown.
        machine.answer(Capture, 1, round, Answer::Asking, &mut windows);
        assert!(machine.fallback_due(round, 2).is_empty());
        assert_eq!(machine.status(Capture).vote, Some(Vote::Asking));
    }

    #[test]
    fn quit_while_granted_is_reported_and_keeps_the_grant() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        granted(&mut machine, &mut windows, 1, "p");
        let (prevent, effects) = machine.request_quit(0, &mut windows);
        assert!(prevent);
        assert_eq!(effects, vec![Effect::Report(RESTARTING.into())]);
        assert_eq!(machine.status(Capture).phase, PhaseName::Granted);
        assert_eq!(machine.relaunch(1, "p"), vec![Effect::Restart]);
    }

    #[test]
    fn discard_is_recorded_only_after_a_confirmed_hide() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.request_quit(9, &mut windows);
        let round = round_of(&machine);
        machine.answer(Todos, 1, round, Answer::Ready, &mut windows);
        let silent = machine.fallback_due(round, 1);
        assert_eq!(silent, vec![(Capture, 1)]);
        assert_eq!(machine.status(Capture).vote, Some(Vote::None));
        assert!(machine.may_reveal(Capture));
        let effects = machine.discard(round, &silent, &mut windows);
        assert_eq!(effects, vec![Effect::Nudge(Capture), Effect::Exit(9)]);
        assert_eq!(windows.log, ["hide capture"]);
        assert_eq!(machine.status(Capture).vote, Some(Vote::Discarded));
    }

    #[test]
    fn a_discarded_page_stays_hidden_and_ignored_until_the_round_ends() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.request_quit(0, &mut windows);
        let round = round_of(&machine);
        machine.answer(Todos, 1, round, Answer::Asking, &mut windows);
        let silent = machine.fallback_due(round, 1);
        assert_eq!(silent, vec![(Capture, 1)]);
        assert_eq!(
            machine.discard(round, &silent, &mut windows),
            vec![Effect::Nudge(Capture)]
        );
        assert!(!machine.may_reveal(Capture));
        assert!(machine.may_reveal(Todos));
        assert_eq!(machine.status(Capture).vote, Some(Vote::Discarded));
        // The page waking up cannot undo the person's discard.
        assert!(machine
            .answer(Capture, 1, round, Answer::Cancel, &mut windows)
            .is_empty());
        // A repeated Quit does not show it again.
        windows.log.clear();
        machine.request_quit(0, &mut windows);
        assert!(!windows.log.iter().any(|entry| entry.ends_with("capture")));
        // Todos keeps working: Capture comes back as it was.
        let effects = machine.answer(Todos, 1, round, Answer::Cancel, &mut windows);
        assert_eq!(effects, vec![Effect::Nudge(Capture), Effect::Nudge(Todos)]);
        assert!(windows.is_visible(Capture));
        assert!(machine.may_reveal(Capture));
    }

    #[test]
    fn a_refused_hide_records_nothing_and_cancels_visibly() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        windows.refuse_hide = [true, false];
        machine.prepare_restart(4, "prepare-1".into(), &mut windows);
        let round = round_of(&machine);
        let silent = machine.fallback_due(round, 1);
        let effects = machine.discard(round, &silent, &mut windows);
        assert_eq!(machine.status(Capture).phase, PhaseName::Idle);
        assert_eq!(reports(&effects), 1);
        assert_eq!(replies(&effects).len(), 1);
        assert!(replies(&effects)[0].is_err());
        assert!(windows.is_visible(Capture));
    }

    #[test]
    fn an_applied_hide_that_cannot_be_confirmed_is_undone() {
        // The hide took effect, then the window could not report its state.
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        windows.blind_after_hide = [true, false];
        machine.request_quit(0, &mut windows);
        let round = round_of(&machine);
        let silent = machine.fallback_due(round, 1);
        let effects = machine.discard(round, &silent, &mut windows);
        assert_eq!(machine.status(Capture).phase, PhaseName::Idle);
        assert_eq!(reports(&effects), 1);
        assert_eq!(machine.status(Capture).vote, None, "nothing was discarded");
        assert!(
            windows.is_visible(Capture),
            "the touched window is shown again"
        );
        assert_eq!(windows.log, ["hide capture", "show capture"]);
    }

    #[test]
    fn a_failed_hide_at_grant_cancels_instead_of_granting() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, false);
        windows.blind_after_hide = [false, true];
        machine.prepare_restart(4, "prepare-1".into(), &mut windows);
        let round = round_of(&machine);
        machine.answer(Capture, 1, round, Answer::Ready, &mut windows);
        let effects = machine.answer(Todos, 1, round, Answer::Ready, &mut windows);
        assert_eq!(replies(&effects).len(), 1);
        assert!(replies(&effects)[0].is_err());
        assert_eq!(reports(&effects), 1);
        assert_eq!(machine.status(Capture).phase, PhaseName::Idle);
        assert!(windows.is_visible(Capture), "Capture was visible before");
    }

    #[test]
    fn restart_with_no_participant_windows_is_granted_at_once() {
        let mut machine = loaded();
        let effects = machine.prepare_restart(2, "prepare-1".into(), &mut Fake::none());
        assert_eq!(
            effects,
            vec![Effect::Reply {
                sidecar: 2,
                request_id: "prepare-1".into(),
                result: Ok(())
            }]
        );
        assert_eq!(machine.status(Capture).phase, PhaseName::Granted);
        assert!(!machine.may_create());
        assert_eq!(machine.relaunch(2, "prepare-1"), vec![Effect::Restart]);
        assert_eq!(machine.status(Capture).phase, PhaseName::Leaving);
    }

    #[test]
    fn an_aborted_grant_restores_each_window_as_the_round_found_it() {
        // The person had closed Todos. It asks, is shown, agrees, and the grant
        // hides both windows; the abort shows Capture and hides Todos again.
        let mut machine = loaded();
        let mut windows = Fake::new(true, false);
        machine.prepare_restart(7, "prepare-1".into(), &mut windows);
        let round = round_of(&machine);
        machine.answer(Todos, 1, round, Answer::Asking, &mut windows);
        assert!(windows.is_visible(Todos));
        machine.answer(Todos, 1, round, Answer::Ready, &mut windows);
        machine.answer(Capture, 1, round, Answer::Ready, &mut windows);
        assert_eq!(machine.status(Todos).phase, PhaseName::Granted);
        assert!(!windows.is_visible(Capture) && !windows.is_visible(Todos));
        assert!(!machine.may_reveal(Capture) && !machine.may_create());
        // A page cannot cancel a grant, and Bun's late cancel cannot either.
        assert!(machine
            .answer(Capture, 1, round, Answer::Cancel, &mut windows)
            .is_empty());
        assert!(machine
            .prepare_cancel(7, "prepare-1", &mut windows)
            .is_empty());
        // Another request id or generation cannot release it.
        assert!(machine
            .relaunch_abort(7, "prepare-2", &mut windows)
            .is_empty());
        assert!(machine
            .relaunch_abort(8, "prepare-1", &mut windows)
            .is_empty());
        assert!(machine.relaunch(8, "prepare-1").is_empty());
        let effects = machine.relaunch_abort(7, "prepare-1", &mut windows);
        assert_eq!(effects, vec![Effect::Nudge(Capture), Effect::Nudge(Todos)]);
        assert!(windows.is_visible(Capture));
        assert!(
            !windows.is_visible(Todos),
            "Todos stays as the person left it"
        );
        assert_eq!(machine.status(Capture).phase, PhaseName::Idle);
    }

    #[test]
    fn a_reload_while_collecting_a_restart_cancels_it_with_its_reply() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.prepare_restart(3, "prepare-1".into(), &mut windows);
        let round = round_of(&machine);
        machine.answer(Capture, 1, round, Answer::Asking, &mut windows);
        let silent = machine.fallback_due(round, 1);
        assert_eq!(silent, vec![(Todos, 1)]);
        machine.discard(round, &silent, &mut windows);
        assert!(!windows.is_visible(Todos));
        let effects = machine.page_replaced(Capture, &mut windows);
        assert_eq!(machine.status(Capture).phase, PhaseName::Idle);
        assert_eq!(machine.status(Capture).generation, 2);
        assert!(windows.is_visible(Todos));
        assert_eq!(
            replies(&effects),
            vec![&Err(
                "Capture reloaded or closed while Epicenter was asking it, so the restart was cancelled."
                    .to_string()
            )]
        );
        assert_eq!(reports(&effects), 0, "Bun reports the restart");
    }

    #[test]
    fn a_reload_while_collecting_a_quit_is_reported() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.request_quit(0, &mut windows);
        let effects = machine.page_replaced(Todos, &mut windows);
        assert_eq!(machine.status(Capture).phase, PhaseName::Idle);
        assert!(replies(&effects).is_empty());
        assert_eq!(
            effects[0],
            Effect::Report(
                "Todos reloaded or closed while Epicenter was asking it, so Epicenter stayed open. Quit again to leave."
                    .into()
            )
        );
    }

    #[test]
    fn a_reload_while_granted_only_invalidates_that_page() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        let round = granted(&mut machine, &mut windows, 3, "prepare-1");
        windows.log.clear();
        assert!(machine.page_replaced(Capture, &mut windows).is_empty());
        assert!(windows.log.is_empty());
        let status = machine.status(Capture);
        assert_eq!(status.phase, PhaseName::Granted);
        assert_eq!(status.generation, 2);
        assert_eq!(status.vote, Some(Vote::None));
        assert!(machine
            .answer(Capture, 2, round, Answer::Cancel, &mut windows)
            .is_empty());
        assert_eq!(machine.status(Todos).vote, Some(Vote::Ready));
        assert!(!machine.may_reveal(Todos));
        assert_eq!(machine.relaunch(3, "prepare-1"), vec![Effect::Restart]);
    }

    #[test]
    fn a_late_bun_cancel_ends_only_a_collecting_round() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.prepare_restart(5, "prepare-1".into(), &mut windows);
        assert!(machine.prepare_cancel(5, "other", &mut windows).is_empty());
        assert!(machine
            .prepare_cancel(6, "prepare-1", &mut windows)
            .is_empty());
        let effects = machine.prepare_cancel(5, "prepare-1", &mut windows);
        assert_eq!(replies(&effects).len(), 1);
        assert_eq!(machine.status(Capture).phase, PhaseName::Idle);
        assert!(machine
            .prepare_cancel(5, "prepare-1", &mut windows)
            .is_empty());
    }

    #[test]
    fn every_preparation_gets_exactly_one_terminal_reply() {
        type Scenario = fn(&mut Machine, &mut Fake) -> Vec<Effect>;
        let scenarios: [(&str, Scenario); 8] = [
            ("no windows", |machine, _| {
                machine.prepare_restart(1, "p".into(), &mut Fake::none())
            }),
            ("busy", |machine, windows| {
                machine.request_quit(0, windows);
                machine.prepare_restart(1, "p".into(), windows)
            }),
            ("page cancel", |machine, windows| {
                let mut effects = machine.prepare_restart(1, "p".into(), windows);
                let round = round_of(machine);
                effects.extend(machine.answer(Capture, 1, round, Answer::Cancel, windows));
                effects.extend(machine.answer(Todos, 1, round, Answer::Cancel, windows));
                effects.extend(machine.prepare_cancel(1, "p", windows));
                effects
            }),
            ("bun cancel", |machine, windows| {
                let mut effects = machine.prepare_restart(1, "p".into(), windows);
                effects.extend(machine.prepare_cancel(1, "p", windows));
                effects.extend(machine.prepare_cancel(1, "p", windows));
                effects
            }),
            ("person keeps open", |machine, windows| {
                let mut effects = machine.prepare_restart(1, "p".into(), windows);
                let round = round_of(machine);
                machine.fallback_due(round, 1);
                effects.extend(machine.fallback_keep(round, windows));
                effects.extend(machine.fallback_keep(round, windows));
                effects
            }),
            ("discard then grant", |machine, windows| {
                let mut effects = machine.prepare_restart(1, "p".into(), windows);
                let round = round_of(machine);
                machine.answer(Todos, 1, round, Answer::Ready, windows);
                let silent = machine.fallback_due(round, 1);
                effects.extend(machine.discard(round, &silent, windows));
                effects.extend(machine.discard(round, &silent, windows));
                effects.extend(machine.prepare_cancel(1, "p", windows));
                effects
            }),
            ("reload", |machine, windows| {
                let mut effects = machine.prepare_restart(1, "p".into(), windows);
                effects.extend(machine.page_replaced(Todos, windows));
                effects.extend(machine.page_replaced(Capture, windows));
                effects
            }),
            ("repeated quit", |machine, windows| {
                let mut effects = machine.prepare_restart(1, "p".into(), windows);
                effects.extend(machine.request_quit(0, windows).1);
                effects.extend(machine.request_quit(0, windows).1);
                let round = round_of(machine);
                effects.extend(machine.answer(Capture, 1, round, Answer::Cancel, windows));
                effects
            }),
        ];
        for (name, scenario) in scenarios {
            let mut machine = loaded();
            let mut windows = Fake::new(true, true);
            let effects = scenario(&mut machine, &mut windows);
            assert_eq!(replies(&effects).len(), 1, "{name}: {effects:?}");
        }
    }

    #[test]
    fn quit_and_restart_never_merge() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.request_quit(0, &mut windows);
        let effects = machine.prepare_restart(1, "q".into(), &mut windows);
        assert_eq!(replies(&effects), vec![&Err(BUSY.to_string())]);
        assert_eq!(machine.status(Capture).intent, Some(IntentName::Quit));

        let mut machine = loaded();
        granted(&mut machine, &mut windows, 1, "p");
        let effects = machine.prepare_restart(1, "q".into(), &mut windows);
        assert_eq!(replies(&effects), vec![&Err(BUSY.to_string())]);
    }

    #[test]
    fn retiring_a_sidecar_ends_only_its_own_round() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.prepare_restart(1, "p".into(), &mut windows);
        assert!(machine.retire_sidecar(2, &mut windows).is_empty());
        let effects = machine.retire_sidecar(1, &mut windows);
        assert!(replies(&effects).is_empty(), "nobody is left to read it");
        assert_eq!(effects, vec![Effect::Nudge(Capture), Effect::Nudge(Todos)]);
        assert_eq!(machine.status(Capture).phase, PhaseName::Idle);

        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        granted(&mut machine, &mut windows, 1, "p");
        machine.retire_sidecar(1, &mut windows);
        assert!(windows.is_visible(Capture) && windows.is_visible(Todos));
        assert_eq!(machine.status(Capture).phase, PhaseName::Idle);

        // A quit round belongs to the person, not to a Bun generation.
        let mut machine = loaded();
        machine.request_quit(0, &mut windows);
        assert!(machine.retire_sidecar(1, &mut windows).is_empty());
        assert_eq!(machine.status(Capture).phase, PhaseName::Collecting);
    }

    /// Work that was scheduled for one round, and arrives after it ended and
    /// a newer round began with a newer page, finds nothing to act on and
    /// touches no window.
    #[test]
    fn delayed_work_from_an_ended_round_never_touches_a_newer_one() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.request_quit(0, &mut windows);
        let old = round_of(&machine);
        let old_listing = machine.fallback_due(old, 1);
        assert_eq!(old_listing, vec![(Capture, 1), (Todos, 1)]);
        // The old round ends; Capture reloads; a restart round begins and
        // Capture's new page discards nothing yet but is deciding.
        machine.answer(Todos, 1, old, Answer::Cancel, &mut windows);
        machine.page_replaced(Capture, &mut windows);
        machine.prepare_restart(9, "new".into(), &mut windows);
        let new = round_of(&machine);
        assert_ne!(new, old);
        machine.answer(Capture, 2, new, Answer::Asking, &mut windows);
        let version = machine.status(Capture).version;
        windows.log.clear();

        // The old dialog's decision, its timer, and Bun frames for nothing.
        assert!(machine.discard(old, &old_listing, &mut windows).is_empty());
        assert!(machine.fallback_keep(old, &mut windows).is_empty());
        assert!(machine.fallback_due(old, 1).is_empty());
        assert!(machine.prepare_cancel(9, "old", &mut windows).is_empty());
        assert!(machine.relaunch_abort(9, "new", &mut windows).is_empty());
        assert!(machine.retire_sidecar(8, &mut windows).is_empty());
        assert!(windows.log.is_empty(), "{:?}", windows.log);
        assert_eq!(machine.status(Capture).version, version);
        assert_eq!(machine.status(Capture).vote, Some(Vote::Asking));

        // Even a listing for the current round names the old page.
        machine.discard(new, &[(Capture, 1)], &mut windows);
        assert!(windows.log.is_empty());
        assert_eq!(machine.status(Capture).vote, Some(Vote::Asking));

        // After the new round is granted, the old round's Bun frames still
        // touch nothing, and the grant's windows stay hidden.
        machine.answer(Capture, 2, new, Answer::Ready, &mut windows);
        machine.answer(Todos, 1, new, Answer::Ready, &mut windows);
        assert_eq!(machine.status(Capture).phase, PhaseName::Granted);
        windows.log.clear();
        assert!(machine
            .discard(new, &[(Capture, 2)], &mut windows)
            .is_empty());
        assert!(machine.fallback_keep(new, &mut windows).is_empty());
        assert!(machine.prepare_cancel(9, "new", &mut windows).is_empty());
        assert!(windows.log.is_empty());
        assert!(!windows.is_visible(Capture));
    }

    #[test]
    fn discard_takes_only_pages_still_at_the_listed_generation() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.request_quit(0, &mut windows);
        let round = round_of(&machine);
        let silent = machine.fallback_due(round, 1);
        assert_eq!(silent, vec![(Capture, 1), (Todos, 1)]);
        machine.answer(Todos, 1, round, Answer::Ready, &mut windows);
        // A page that answered asking since is still the person's to discard.
        machine.answer(Capture, 1, round, Answer::Asking, &mut windows);
        windows.log.clear();
        machine.discard(round, &silent, &mut windows);
        assert_eq!(windows.log, ["hide capture"]);
        assert_eq!(machine.status(Capture).vote, Some(Vote::Discarded));
        assert_eq!(machine.status(Todos).vote, Some(Vote::Ready));
        assert_eq!(machine.status(Todos).phase, PhaseName::Leaving);
    }

    #[test]
    fn silent_pages_left_after_a_discard_get_another_fallback() {
        let mut machine = loaded();
        let mut windows = Fake::new(true, true);
        machine.request_quit(0, &mut windows);
        let round = round_of(&machine);
        machine.answer(Todos, 1, round, Answer::Asking, &mut windows);
        let silent = machine.fallback_due(round, 1);
        assert_eq!(silent, vec![(Capture, 1)]);
        // Todos hangs after asking; a repeated Quit makes it silent again
        // while the first dialog is still open.
        let (_, effects) = machine.request_quit(0, &mut windows);
        assert!(!effects
            .iter()
            .any(|effect| matches!(effect, Effect::ArmFallback { .. })));
        let effects = machine.discard(round, &silent, &mut windows);
        assert_eq!(
            effects,
            vec![
                Effect::Nudge(Capture),
                Effect::ArmFallback { round, arm: 3 }
            ]
        );
        assert_eq!(machine.fallback_due(round, 3), vec![(Todos, 1)]);
    }
}
