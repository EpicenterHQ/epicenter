# Example conversations

These illustrations show possibilities through their results: prose to read,
code to use, and conversations a skill could produce. They are not measured
runs or records of the user's preferences. The reactions help discover what
matters; they need not select one of the original options. The examples teach
judgment, not a fixed sequence, number of versions, or response format.

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

The services and their constraints in these sample conversations are fictional.

> **Human:** The architecture-review skill gives me a huge analysis. It doesn't
> feel like we're thinking together.
>
> **Agent:** I'd make it take a position earlier and leave room to develop it
> with you. These two conversations start with the same question, but give you
> something different to respond to.
>
> **1. Start with a recommendation**
>
>> **Human:** I'm thinking about combining these two services.
>>
>> **Agent:** I'd probably combine them. They share a database, deploy together,
>> and most changes touch both. Billing's write restrictions are worth keeping,
>> but they may not require a separate deployment. What's making you hesitate?
>>
>> **Human:** Mostly protecting billing from unrelated code.
>>
>> **Agent:** Then I'd combine the deployment and keep billing behind a narrow
>> internal API. That preserves the restriction while removing release coordination.
>
> **2. Start with what led you here**
>
>> **Human:** I'm thinking about combining these two services.
>>
>> **Agent:** What happened recently that made you want to combine them?
>>
>> **Human:** I had to coordinate two deployments for a tiny change.
>>
>> **Agent:** If deploying them together were easy, would you still want to
>> combine them? That would help distinguish a deployment problem from a boundary
>> that makes ordinary changes harder.
>>
>> **Human:** Almost every change crosses it. Deployment is only part of it.
>>
>> **Agent:** Then I'd examine combining them. Their billing write restriction
>> can remain an internal boundary; making it a separate service may be adding
>> work without providing the isolation you need.
>
> **Agent:** I'd lean toward 1 for your complaint: it gives you something to
> push against immediately. The useful part of 2 is finding out what prompted
> the question before getting attached to a solution.
>
> **Human:** I want both. Have an opinion, but stay interested in why I'm asking.
> I don't want an interview before you tell me anything.
>
> **Agent:** Then I'd try this opening:
>
>> Combining them looks reasonable because they deploy and change together.
>> I'd preserve billing's write restrictions inside the combined service.
>> What happened that made you consider it now? That could change whether
>> combining them is the right fix.
>
> **Human:** That's closer. Update the skill that way.
>
> **Agent:** I'll replace the push toward exhaustive analysis with that
> judgment: offer a grounded provisional view and investigate what could change
> it. The example's exact wording doesn't need to become a required opening.
