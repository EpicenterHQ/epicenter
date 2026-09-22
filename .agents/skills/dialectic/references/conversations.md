# Example conversations

These illustrations pair an articulation of the model with a concrete
expression: prose to read, caller code, a conversation a skill could produce,
or a rendered website. The articulation explains the proposed meaning or
arrangement; the expression lets the user judge the choices made in realizing
it. They are not measured runs or records of the user's preferences. Reactions
may change either or both. The examples teach judgment, not a fixed sequence,
number of versions, or response format.

## Writing: experience different readings of one transcript

These drafts draw on the preserved voice transcript of The Death of Deep Work.
They are a collaboration exercise, not revisions to that finished page. The
human's later reply below is hypothetical, not a recorded preference.

> **Human:** Coding agents have made me more productive, but I miss sitting
> down for hours to build a feature. Now it's like being on call. I still read
> a lot and steer the agents, but the thinking feels different. Help me write
> about that.
>
> **Agent:** There's both the constant availability and the change in what
> the thinking feels like. Here are two ways to keep both while letting a
> different one lead.
>
> **1. Always on call**
>
> This version argues that greater productivity has come with a demand for
> constant availability. The loss is having time that belongs to one thing.
>
>> Coding agents have made it easier to produce code and harder to leave work alone.
>>
>> I used to sit down and spend hours building a feature. Now I give an agent
>> something to do, wait, read what it produces, and respond. While one is
>> working, I can start another. There is almost always something ready for
>> my attention.
>>
>> It starts to feel like being on call. I don't have to be actively coding
>> all day, but it helps to keep being available.
>>
>> The productivity is real. More code gets written. I still do plenty of
>> thinking, and I arguably read more than I did before. There's judgment in
>> knowing what to ask for, what to keep, and when an agent has gone in the
>> wrong direction.
>>
>> But I miss sitting with a problem. I miss having a stretch of time that
>> belongs to one thing, instead of a day spent responding whenever something
>> needs me.
>>
>> Coding takes less of my effort now. Somehow, it keeps asking for my attention.
>
> **2. I miss figuring it out**
>
> This version locates the loss in the work itself: evaluating a solution
> feels different from discovering one through your own attempts.
>
>> I'm writing more code than ever, and I miss coding.
>>
>> The productivity is real. I use coding agents because they're useful.
>> But there was something satisfying about spending hours inside a problem.
>> I liked trying an approach, finding out why it didn't work, and gradually
>> understanding what would.
>>
>> Now much of that happens before I see the result. I read the code, decide
>> whether it makes sense, and steer the next attempt. I still think a lot.
>> I probably read more than before. But evaluating a solution feels different
>> from finding one.
>>
>> The rhythm has changed too. Instead of settling into a feature for an
>> afternoon, I keep checking whether an agent is ready for me. I'm doing more
>> reviewing and directing, often in smaller pieces throughout the day.
>>
>> I don't want to pretend the old way was always better. Plenty of those
>> hours were frustrating. But some of them were the reason I liked the work.
>
> **Agent:** I'd build from 2. It gives more room to the work you enjoyed doing.
> The observation about constant availability in 1 could strengthen its middle.
>
> **Human:** The line about evaluating a solution is close. But sometimes
> reviewing the agent's work is really interesting too. It's more that I
> can't stay with a thought.
>
> **Agent:** Then I'd change the middle. Reviewing isn't necessarily the loss;
> being pulled away keeps you from following the interesting part:
>
>> I still find things worth thinking about. Sometimes reading an agent's
>> solution sends me somewhere I wouldn't have gone on my own. But before
>> I've followed that thought very far, another agent needs a response.
>>
>> I miss having time to stay with the interesting part, whether I found it
>> myself or an agent put it in front of me.

The articulation concerns what the piece is trying to say; the concrete
expression is the prose itself. Here the reaction changes the interpretation,
so the next attempt revises both. If the author agreed with the interpretation
but disliked a phrase, that could call for a local change in expression.


## API design: make the caller's choices visible

This hypothetical example draws on Epicenter's independent-resource API design.
The caller code makes acquisition and cleanup visible so the human can judge
using the design. These are sketches, not a runnable application or a claim
about current package exports. Unrelated setup is omitted.

> **Human:** Opening an entire app just to read an audio file feels wrong.
>
> **Agent:** I'd let the caller open file storage directly. Reading bytes
> doesn't require table definitions or an account:
>
> ```ts
> import { openLocalBlobs } from '@epicenter/app/blobs';
>
> const blobs = await openLocalBlobs({ id: 'audio-preview' });
> try {
>   const result = await blobs.get(blobId);
>   // Preview the audio from the result.
> } finally {
>   await blobs.close();
> }
> ```
>
> **Agent:** The cost is that callers opening several resources now own their
> cleanup. I'd keep that responsibility in the screen or product using them,
> rather than make every resource belong to an app again.
>
> **Human:** Yes. What if I add recording? Could the recorder take the same ID?
>
> **Agent:** It could. The difference is whether it opens its own storage or
> uses storage you've already opened. Here's what the caller would write.
>
> **1. The recorder opens its storage**
>
> ```ts
> // An alternative API sketch, not an existing constructor.
> const recorder = await openRecorder({ id: 'audio-preview' });
> try {
>   // Capture audio into the recorder's own storage.
> } finally {
>   await recorder.close();
> }
> ```
>
> **2. Pass the storage to the recorder**
>
> Storage is an independent resource. The recorder uses it without owning its
> lifetime, so recording can stop while storage stays available for preview.
>
> ```ts
> import { openLocalBlobs } from '@epicenter/app/blobs';
> import { createRecorder } from '@epicenter/app/recorder';
>
> const blobs = await openLocalBlobs({ id: 'audio-preview' });
> try {
>   const recorder = createRecorder({ blobs });
>   try {
>     // Capture audio into this storage; preview can use it too.
>   } finally {
>     await recorder.close();
>   }
> } finally {
>   await blobs.close();
> }
> ```
>
> **Agent:** I'd use 2 here. Recording and preview already need the same
> storage. Passing it makes that sharing explicit, and closing the recorder
> can leave preview usable. Version 1 is convenient for a recorder that owns
> the whole session, but sharing its storage would need another decision.
>
> **Human:** That's the part I care about. Recording can stop while preview
> stays open. The nested cleanup still looks heavy.
>
> **Agent:** Keep that lifetime distinction. The recording screen can manage
> these handles once, so its event handlers just use them. I'd check that
> actual caller before adding a shared helper; the smaller preview-only tool
> shouldn't inherit a recording session it doesn't need.

## Agent skills: experience the behavior before encoding it

All exchanges below are invented samples. The services and their constraints
are fictional; the outer reactions illustrate discovery, not recorded preferences.

> **Human:** The architecture-review skill gives me a huge analysis. It doesn't
> feel like we're thinking together.
>
> **Agent:** I'd have it offer a provisional recommendation and ask what could
> change that judgment. Here's a sample of how the conversation might develop.
>
>> **Human:** I'm thinking about combining these two services.
>>
>> **Agent:** I'd lean toward combining them: they share a database, deploy
>> together, and most changes touch both. I'd preserve billing's write
>> restrictions behind an internal API. What prompted this now?
>>
>> **Human:** Yesterday a tiny change needed two deployments. But billing is
>> about to move to another team.
>>
>> **Agent:** Separate ownership could make independent deployment useful.
>> I'd check whether the new team needs to release billing without coordinating
>> with you before deciding to merge.
>>
>> **Human:** I don't know yet. I'm meeting them tomorrow.
>>
>> **Agent:** Find that out tomorrow, then we can decide whether merging is
>> still the right move.
>
> **Human:** That starts well, and I like that it changes its mind. But now
> it's handed the work back to me. I'd want help figuring out tomorrow's
> conversation. Having an opinion and asking questions isn't quite enough.
>
> **Agent:** The missing part is helping you act on the uncertainty. The skill
> needs to carry the work forward even when it can't settle the original
> decision. Here's that same situation with the consequence carried through.
>
>> **Human:** I'm thinking about combining these two services.
>>
>> **Agent:** I'd lean toward combining them: they share a database, deploy
>> together, and most changes touch both. I'd preserve billing's write
>> restrictions behind an internal API. What prompted this now?
>>
>> **Human:** Yesterday a tiny change needed two deployments. But billing is
>> about to move to another team.
>>
>> **Agent:** That makes me less certain. If the new team needs independent
>> releases, merging could create the coordination you're trying to remove.
>> Do you know what they'll own and release on their own?
>>
>> **Human:** I don't know yet. I'm meeting them tomorrow.
>>
>> **Agent:** I'd bring yesterday's change to that meeting and walk through
>> how it would work after the handoff: who changes the code, who approves it,
>> and who releases it. Ask them for a change they'd expect to ship without
>> you, too. Those two cases should show whether the service boundary helps
>> the teams work independently. If both still require joint releases, I'd
>> revisit merging; if billing can ship independently, I'd first fix the
>> deployment friction while keeping that boundary.
>
> **Human:** Yes. That's more like thinking together. Update the skill.
>
> **Agent:** I'll have it offer a grounded provisional judgment, revise that
> judgment when the situation changes, and help make the next useful move
> concrete when uncertainty prevents a decision. The meeting suggestion is
> specific to this example; it doesn't need to become a required step.

The later turns reveal something the initial articulation did not name:
revising a recommendation can still leave the user carrying the unresolved
work. Experiencing the conversation makes that omission available for judgment.


## Blog writing: compare the rendered openings

This illustrative exchange draws on the blog-opening comparison discussed in
conversation `01a0c8c6-13fa-7903-9877-946764e5e8d3`. The proposed follow-up
reaction is hypothetical. The italicized actions stand in for screenshots;
in live work, render and show the actual images.

> **Human:** We've revised the opening several times and I can't tell whether
> it's getting better. Can I see the versions side by side?
>
> **Agent:** The latest opening states the rule, shows the code, then explains
> what happened. The earlier opening gives readers a map of the call chain
> first. I'll show both alongside the original on your blog so you can compare
> how the openings actually read.
>
> *The agent reconstructs the original, ASCII-first, and code-first openings
> from available source history and the conversation. It renders local previews
> in the actual site, keeping the viewport and unrelated styling the same.
> Each capture includes the opening and its transition into the next section.
> The agent checks the captures and shows the three labeled versions together.*
>
> **Agent:** The code-first version gets to a concrete example sooner. The
> ASCII-first version shows the whole chain before asking readers to follow
> the code. I'd start with code-first for someone skimming, but its longer
> code block pushes the explanation farther down the page.
>
> **Human:** Code-first is clearer, but now I see why the quote underneath
> feels repetitive. Keep the opening sentence and code. Try a shorter quote.
>
> *The agent revises only the quote in the code-first preview and renders it
> again. It shows that result beside the previous code-first version, with
> enough surrounding content to judge the transition. The selected opening
> sentence and code remain unchanged.*
>
> **Agent:** Here's the shorter quote in place. It explains the change from
> returning a result to acting on it, without repeating the opening rule.

The articulation describes how the opening should teach the idea. The concrete
expression is the rendered opening, including prose, code, quotation, and their
spacing on the site. Plain text could show the wording but would leave the
reader's path through those elements to the user's imagination. A sentence-only
choice may need only prose in chat; this comparison needs the page.

Use the actual renderer or a local preview, and inspect the result before
showing it. Keep comparison conditions consistent without forcing versions to
have equal heights: changes in flow are part of the result. Previewing a
proposal does not require publishing it or replacing the authored source.
