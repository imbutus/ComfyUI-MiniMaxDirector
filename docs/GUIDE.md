# Using MiniMaxDirector

A guide for people. `AGENTS.md` is the same territory written for a model reading the
code; this one assumes you want to make a video and would rather not read Python.

---

## What the node actually does

MiniMax H3's text encoder is a 32B vision-language model. It does not need keyframes
injected into latent space to understand a shot list — it reads one, written out in
prose. So this node is a **compiler**: you arrange blocks on a timeline, and it writes
the single structured prompt H3 wants.

Nothing is hidden. The `prompt` output is the exact string sent to the model. If the
video is wrong, read that string first — it usually explains itself.

---

## Installing

See **[Install in the README](../README.md#install)** — the nodes, the four model files
with the exact names and directories, and the workflow that wires them together. It is
kept in one place so the two cannot drift apart.

The short version: ComfyUI 0.31.0 or newer, no pip install, no dependencies, and **two**
VAEs rather than one — H3 produces picture and sound in the same pass. The workflow's
**Upscale** switch is the one exception: it is off by default, and turning it on needs a
second node pack, which the README's Install names.

---

## Wiring it up

The example workflow in `examples/` is already wired; open it and swap in your files.
Built by hand, the chain is:

```
UNETLoader ─┐
CLIPLoader ─┼─► MiniMax Director ─► BasicGuider ─► SamplerCustomAdvanced ─┬─► VAEDecode ──────┐
VAELoader  ─┤        (positive,                                           │   (video vae)     ├─► CreateVideo ─► SaveVideo
VAELoader  ─┘         latent)                                             └─► VAEDecodeAudio ─┘
                                                                              (audio vae)
```

Two things people get wrong here:

**The same latent goes to both decoders.** H3's latent carries picture and sound
together. There is no second sampler and no separate audio branch to keep in sync.

**No negative prompt.** H3 is CFG-free — `BasicGuider`, not `CFGGuider`. If you find
yourself looking for the negative input, there isn't one.

---

## The timeline

Three tracks, and each block on them describes a span of the clip. The node's own title
bar carries the pack's version and build date at its right end, so a screenshot of a
misbehaving graph says which build drew it.

| Track | Holds | Becomes |
|---|---|---|
| **MAIN** | shots — what is on screen | the `Timeline:` / `SHOT n:` block |
| **CAMERA** | camera moves | the `Camera:` block |
| **AUDIO** | sound cues | the `Audio:` block |

### The six buttons

Three write a description; three attach a file.

| Button | Track | What it makes |
|---|---|---|
| **Add Video Prompt** | MAIN | a shot described in words |
| **Add Sound Prompt** | AUDIO | a sound described in words — H3 generates it |
| **Add Camera Prompt** | CAMERA | a move from the dropdown, plus an optional note |
| **Add Image** | MAIN | a shot with a reference image on it |
| **Add Audio** | AUDIO | a cue with a real audio file |
| **Add Video** | MAIN | a shot with a reference video |

Every Add appends a new block after the last one on that track. Adding never overwrites
a block you already have.

### Files

**Files**, under the transport row beneath the tracks, opens a list in the same place — not
a tab, because the tracks are what a file is dragged onto. It holds every file in the
document: the ones on blocks, shown with the token they compile to, and the ones on no
block at all, shown dashed. One row per file, carrying every token it compiles to — a
reference video is handed to the model twice, as `<Video n>` and as its own `<Audio n>`,
and both are on its row. `×` takes an unplaced file off the clip.

The two ways in mean different things, and that is deliberate:

- **Add Image / Add Audio / Add Video** on the bar place the file on the timeline, because
  a file usually *is* a shot.
- **+ file** inside Files adds a file the clip carries with no moment of its own. Any of the
  three kinds — which one it is comes from the file. Drag it out of the list onto a track
  later and it becomes an ordinary block, at the frame you dropped it: a recording or a clip
  taking the span it actually runs for, a picture two seconds.

Every chip in the list is draggable, placed or not. While you drag, the track that can take
the file lights up and a dashed outline shows the block you would get — where it starts and
how wide it is — drawn by the same rule the drop runs, so releasing lands exactly there.
The drop is **magnetic to the left**: the block lands against the end of whatever you
dropped it after, or at frame 0 on an empty stretch, rather than wherever the pointer was.
Aiming a file at a gap by hand is how a clip ends up with four frames nothing describes.
Dragging an unplaced file **moves** it onto the track; dragging one that is already on a block **copies** it, which is how the same
photograph is used in two shots without going back to disk for it. The copy carries no
subjects: the cast writes those onto the first block holding that file, and defining the
same person twice is not what a second shot of them means.

**Deleting a block keeps its file.** The block was a statement about a stretch of the clip;
the file was chosen, uploaded and described, and losing it because its block was in the
wrong place meant finding it on disk again. It goes back to the Files list, on no block —
as does **detach media** on a block's FILE row. The `×` in Files is the one control that
means "take this file off the clip". A file still carried by another block is not kept
twice: one picture, one `<Picture n>`.

**A file with no moment is not a file with no number.** A block says "this stretch of the
video is about this file", and the compiler writes `(appears in [Shot n])` beside it — which
is what you want for a picture the shot is of, and wrong for a face to be carried onto
whoever is on screen, or a look to hold throughout. Put that on a block and the clip is cut
in two at a seam nobody asked for, with the model changing what it does on either side of
it. Unplaced, it is the same file, numbered with the rest (`<Picture 2>`), describable on a
card, and pointed at from any prompt by its chip — with no shot list of its own. One that
nothing points at — no card, no mention — is a warning, because it is the one kind of file
no block speaks for.

A clip carried this way still brings its own soundtrack, numbered `<Audio n>` with the
blocks' clips and ahead of any cue — the order the model is handed them in. That soundtrack
is a passenger: the compiler leaves it out of the prompt entirely unless something you wrote
names its token, because a clip attached for its motion or its look is not a clip whose sound
you asked for. Named, it is described as the audio in that file and never in the words you
wrote about the picture — those belong to the frames. A clip used as a **continuation** or a
frame anchor keeps its soundtrack declared, because carrying the sound over is the point.

**What a reference video will and will not carry.** Motion is what it holds reliably. Grain,
grade and fine texture are not, and where a clip's grade does land it overrides the light your
words asked for — a sunny terrace in the prompt and an evening clip on the reference list is a
fight your words tend to lose. Ask for a film stock in words, and keep the video for movement.

**A clip can be dropped on MAIN or on AUDIO, and it means two different things.** On MAIN
it is its pictures, with its own sound travelling beside them: `<Video n>` and an `<Audio n>`
of its own. On AUDIO it is the sound alone — the node hands the model that clip's decoded
soundtrack and none of its frames, so there is one `<Audio n>` and no video to reproduce.
Its `keep file` follows the track too: the audio markers there, the visual ones on MAIN.

**An attached audio or video takes the span it actually runs for.** The file is measured
before its block is placed, so an eight-second recording gets eight seconds of clip rather
than a default two — bounded by the block after it and by the end of the clip, so
attaching an album does not produce a two-hour timeline. Its `keep file` and `used as` are
written down at the same moment, so what the pickers show is what the prompt uses.

### Duration comes first

Set the clip length in the **duration** box, then arrange blocks inside it.

- **Dragging** a block stops at the end of the clip. A drag aims at a place on screen,
  and the clip is that screen.
- **Typing** a length in the panel — or pressing an Add button — stretches the clip if it
  has to. A typed number is an instruction, not a gesture.
- **Neither** lets two blocks on one track overlap. Two descriptions of the same frames
  is not something the prompt can express.

**The clip is always a length H3 can render.** The lattice below is `17n+5`, so 144 frames
is not a length that exists: it generates as 158 whatever the editor says. Rather than let
those fourteen frames sit in the output with no shot describing them, the editor lands on
the lattice as you work:

- A block that grows the clip — added, dragged past the end, or given a longer `length` —
  takes the padding itself. Your last block ends up a few frames longer, and the timeline
  is exactly what renders.
- A **duration** typed by hand snaps up on its own. Raising it leaves the blocks alone --
  the clip simply has room to spare. Lowering it past the tracks brings them inside: the
  block nearest the end loses its overhang, a block that no longer starts inside the clip
  is squeezed to ten frames at the end and the one in front of it gives up exactly that
  much, and only a block with nowhere left to stand is removed -- its file staying on the
  clip, in the Files list, the way it does when a block is deleted. Empty means "follow
  the content".

The timeline is drawn to the clip, not past it, so there is nothing empty on the end. The
settings row's `renders 124 f = 5.17s · 120 f rounded up` is the fallback for the cases
that still round — a clip following its content — and stays silent otherwise.

### The tabs

The panel under the toolbar shows one of four things, and remembers which one across a
reload — along with the block that was selected, so a reload comes back to the fields you
were in:

- **TIMELINE** — the tracks, and the fields of whatever block is selected
- **WHO & WHAT** — one card per thing the prompt has to name
- **GLOBAL** — GLOBAL PROMPT and GLOBAL MUSIC, the two things that are set once for the
  whole piece and then left alone
- **IMPORT / EXPORT** — the whole piece as one JSON, out and back in

The first three are where the piece is written, and they sit together on the left.
IMPORT / EXPORT is what you do with the piece once it is written, so it sits apart at the
right-hand end of the row rather than in the run of panels.

### The node's size

Drag the node's bottom-right corner. The height you drag to is kept, and it travels with
the workflow, so a node you made roomy opens roomy next time.

The node is never shorter than what it is drawing. Adding a prompt, a card or a track
makes it taller whatever you dragged to, and the panel below it grows rather than
scrolling — so nothing hangs out through the bottom edge. That means an upward drag can
only take you back down to the content, and no further.

Two ways back to snug: drag the corner up past the content, or right-click the node and
choose **Fit node to content**. Either one forgets the height you asked for.

The card list on WHO & WHAT keeps a height of its own, set by the grip in its own corner.
That is separate from the node's, and it survives a fit.

This works the same on the classic canvas and on Nodes 2.0.

### Import and export

The tab holds the whole piece as one JSON — the timeline, the cards on WHO & WHAT and the
clip's own `width`, `height` and default resize — and four buttons:

- **Save file** — opens the browser's own save dialog, so the folder and the name are
  yours to choose; it suggests `minimax-director-<date>.json`. Firefox and Safari have no
  such dialog and download the file to wherever the browser normally puts one — the line
  beside the buttons names what was written either way
- **Load file** — reads one back
- **Copy** — the same JSON onto the clipboard, to paste into a message or another director
- **Paste** — opens a box: press ⌘V / Ctrl+V in it and the piece loads as it lands

A load replaces the node — the timeline, the cards and the settings — and asks first when
there is anything to lose. Cmd/Ctrl+Z puts the timeline back; the cards are a document of
their own and the undo stack does not hold them, exactly as Clear says. A bare timeline is
accepted too, not just a saved piece: that is what the node's own hidden widget holds, and
it is the JSON you are most likely to have on the clipboard.

The document names the files, it does not carry them: a picture's filename, never its
pixels. Base64 is not an alternative here — a reference video is tens of megabytes, and a
third larger again as text. So a load ends by asking ComfyUI which of the named files it
actually has, and lists the ones it does not, with an **Upload** button: pick them from
disk and every block pointing at each name is re-pointed at the uploaded copy. Files are
paired by name, so a folder full of them can be answered in one go — and when exactly one
file is missing and exactly one is picked, the name need not match, because a file renamed
on disk is the ordinary reason one goes missing. Several of each with no names in common is
a guess, so those are left to each row's own **re-upload**, which names the file it wants.
ComfyUI
renames a collision rather than overwriting a file another workflow is using, which is why
the document is re-pointed rather than trusted to keep the name. The same check runs
whenever the tab is opened, so a workflow somebody sent you says what it is missing without
being imported at all.

**Paste** never reads the clipboard itself. Reading it from a page is a permission —
Chrome grants it silently, Firefox answers with a popup of its own that has to be clicked
first — while pasting into a box needs none, because the paste *is* the permission. So the
button opens the box and loads whatever lands in it, with nothing further to press. The
**Apply** button beside it is for a document typed or edited there by hand.

### A file that is not there

Red means one thing in this editor: broken, and nothing downstream of it can run. (Amber
stays what it always was — incomplete, and still yours to finish.) A file the clip names
and this ComfyUI does not have is marked in red everywhere it appears: the block on the
timeline, the `<Picture 1> …` chip under the prompt, its row in **Files**, and the card's
face and `from` on WHO & WHAT. The count rides on the tab — `IMPORT / EXPORT · 1 missing` —
so it is visible from whichever panel you are working in, and it is checked when the node
loads, not only after an import.

While a file is missing the editor locks: the panels dim and stop taking clicks, and
clicking one flashes the blocks whose file is gone three times, on TIMELINE — they are both
the reason nothing is answering and where the repair is. Three things stay
live, because they are the ways out — **re-upload**, on the block itself and on the file's
row in **Files**; and **Delete** and **Clear**, for when the answer is that the block should
go. **Files** opens itself the moment a file goes missing, so the row that repairs it is on
screen rather than behind a closed panel; close it again and it stays closed until the list
of missing names changes. The button sits in the middle of the block, where the picture would be: a missing
picture, clip or recording leaves an empty rectangle exactly where you are already looking.
Pick any file off disk for it — renamed on disk is the ordinary reason one goes missing, so
the name you pick need not match — and every block, token and card that named the old one
is re-pointed at the copy you upload.

The run itself is refused too, and that is the check that actually holds: the editor's lock
is a browser drawing a warning, while a queue from another tab or from the API never sees
it. The director fails validation before a single frame is sampled, naming the files and
what to do about them, and the report says the same thing while you write.

### Editing a block

Select it — with nothing selected there is no block to edit, and the segment fields are
not on screen — and the TIMELINE tab shows:

- **SEGMENT PROMPT** — what happens in it
- **TIMING** — `start`, `end` and `length` in frames, each with a read-only seconds
  reading beside it, and one line underneath reading the whole span the same way:
  `Start: 0 f | End: 96 f | Length: 96 f = 4.00s`. Frames come first everywhere in the
  editor, including the playhead clock, because frames are what the document stores and
  what H3 is given; seconds are the translation. Every number box in the editor —
  these three, `duration`, `width`, `height` and `same length` — takes effect when you
  press Enter or leave it, not as you type, so one can be cleared and retyped without the
  half-finished number being read, refused and written back at you. What lands in the box
  afterwards is what was actually set: a length stopped by its neighbour, a duration
  snapped up onto the lattice. Enter finishes any field and leaves it, prompt boxes
  included, and leaving a box flattens what is in it: paste a paragraph and it collapses
  to one line the moment you step out, because one line is what the compiled prompt
  carries. Nothing is lost but the line breaks.
- **SHOT** — MAIN blocks only. `enter with` is how the cut into this shot is written —
  `cut` unless you ask for `dissolve`, `fade` or `wipe`; it is not offered on the first
  shot, which is entered from nowhere. `on-screen text` is any words actually visible in
  frame — a sign, a banner, a label — sent in double quotes, verbatim and untranslated,
  the same service the dialogue row does for the spoken words.
- **The subject chips** sit along the bottom of the prompt box itself — one per card
  WHO & WHAT has numbered, each with the file's thumbnail and the token it became:
  `<Subject 1> man`. Click one and the token is written into the box above it at the
  caret; a chip whose token that box already names is lit. The GLOBAL PROMPT box carries
  the same strip, because a style or a place is usually named once for the whole clip.
  Typing the number by hand is the alternative, and getting it wrong is silent — the
  prompt then cites a subject that does not exist and nothing on screen says so. A card
  with no description takes no number and so has no chip.

  Naming a subject in a *later* shot is how a thing stays the same thing across a cut: the
  same basket in three shots is one `<Subject 1>` written into all three, not three
  descriptions of a basket. The compiler follows — the card's line in `retention_analysis`
  reads `(appears in [Shot 1], [Shot 2] and [Shot 3])` rather than naming only the shot its
  file sits on. Without it the model is told the basket belongs to one shot and is free to
  invent another for the next.
- **The file chips** follow them on the same strip, told apart by shape rather than by
  reading them: a subject is a pill with a round face, a file is square-cornered with a
  square thumbnail and a monospaced name — `<Picture 2> face.jpg`,
  `<Audio 1> voice.mp3`, `<Video 1> clip.mp4` — one per file on the timeline, whether or
  not a card names it. A file is written into its own block's line by the compiler, but
  pointing at it from anywhere else is on you: a recording the mouth must follow, a
  picture a later shot refers back to. These click in the same way, and they carry the
  number the compiler will use, which moves when a block is dragged. With no cards and no
  files there is nothing to show and the strip is absent.
- **CAMERA** — the move; CAMERA blocks only. A shot describes what is on screen, a
  camera block describes how it is filmed, and a move is free to straddle a cut.
  `strength` and `speed` sit beside it: how far the framing travels and how fast — the
  picker says `strength`, the compiled sentence keeps MiniMax's own word, amplitude. Both
  default to *medium* and *normal*, which the guide writes by saying nothing, so those
  options contribute no words. A static shot has neither, and the two pickers go away.
- **DIALOGUE** — MAIN blocks only. One row per line: the `line` itself, the faces of who
  says it, `how` it is said, its `language`, and two switches — **off-screen** and
  **carries over**. **+ line** adds another row, so a block can hold a conversation — dead, dashed and
  amber while a row on this block still has no words, because the compiler ignores a
  wordless row and a second one is a second nothing. The
  red bin at the end of a row removes it — the same delete button the subject cards use.
  The cast is held on that row as a **deck of cards** — each face peeking out from behind
  the one in front, whoever speaks this line lit with a bright ring. Hover it and the hand
  fans out to the right, over the fields after it, wrapping at the node's edge if it is a
  large cast; the order never changes, so the face you reached for last time is where it
  was. A card with no file wears its own initial on a plain token instead of a thumbnail.
  Clicking a face hands the line to that person alone; hold **Cmd/Ctrl** and click to add
  another, and another. The last lit face cannot be unticked, and says why on hover: an
  empty speaker list is compiled as `(S1)`, so a line with nobody ticked would be given to
  speaker 1 rather than to nobody. A line nobody says is a line removed. Who the speakers
  *are* is written once in the WHO & WHAT tab, not here — see below.
- **FILE** — blocks carrying one: `used as`, `keep file`, **detach media**, and a
  read-only `describes` list — one subject per line, `edit` beside each, and
  **+ another card** under them, which makes a card already pointed at this file. That is
  how one photograph holds several subjects: a person, their coat, the room behind them. There is no description box here: what a file *is* is
  written once, on a subject card, and this line shows the card's sentence beside the
  `<Subject n>` it became with a link to the WHO & WHAT tab. It said `nothing describes
  this file yet` until you add one. The guide asks for a file used to define something to
  be cited inside that thing's definition rather than given an entry of its own, so a
  second box here was a field the prompt threw away — which is exactly how it behaved.
  Text typed on the block by an older build still compiles and is shown greyed, with the
  card's sentence taking over the moment there is one. A recording has no `describes` half
  at all: a card is drawn from a picture or a clip, so no card's `from` box can name an
  mp3, and on an audio block the FILE group takes the whole row instead.

  A **frame anchor** — `first frame`, `keyframe` or `last frame` — carries no description
  box either. The picture is handed to the vision encoder along with the prompt
  (`clip.tokenize(prompt, images=…)` in core's `nodes_minimax_h3.py`), so a sentence about
  what is in it tells the model nothing it cannot see, and every source for one is wrong
  somewhere: a filename says nothing, and the shot's own prose is the motion across the
  shot, which a *last* frame does not contain. So an anchor names the frame it is —
  *"<Picture 1> is the first frame of [Shot 1]."* — and `retention_analysis` says the same.
  Cards still work on an anchor: somebody lifted out of that frame gets a `<Subject n>` as
  usual, and the frame keeps its own entry either way.

**Several blocks selected** turns the panel into a selection panel, offering only what
applies to all of them: `motion` / `strength` / `speed` when they are all camera moves,
`enter with` when they are all shots, `used as` and `keep file` when they all carry a file
of one kind. Each picker starts on *leave as is* and writes nothing until you choose.

**Timing** is always there, whatever the mix, because a frame count means the same thing
on every track: `same length` gives every selected block one length (each still stopped by
its own neighbours), and **close the gaps** butts them up against each other, track by
track, leaving the first of each where it is.

Two more actions, drawn only when the selection holds a shot — with none, they would be
two buttons that could never light. With shots selected but not adjacent, or without
dialogue, they stay disabled and say what to select instead:

- **merge into one shot** — adjacent shots become one, prose joined, dialogue kept in the
  order it was heard. This is what MiniMax asks for when a cut only changes the distance
  or the angle, and it is the fix for the linter's warning about exactly that.
- **make the speech continuous** — marks the last spoken line of every selected shot but
  the last as `carries over`, so one sentence is written across the cuts with
  `<scenetrans>` on both sides of each.

`used as` says what the file is *for*, and that decides the task type the prompt opens
with: `reference` (guidance), `storyboard` (a plan of the framing rather than content —
it compiles as *"<Picture 3> is a storyboard reference for [Shot 1], defining viewpoint,
subject placement, and shot order."*), `first frame` / `keyframe` / `last frame` (a real
frame of the target video), `continue from`, `edit`.

**The picker asks the file what it could be for.** All seven are legal to store — the
compiler reads whatever the record says — but most mean nothing on most files: a video set
to `first frame` has no input to go to and changes only the wording, and an audio file set
to `storyboard` describes a frame that does not exist. So a picture is offered `reference`,
`storyboard` and the three frame anchors; a video `reference`, `continue from` and `edit`;
a recording `reference` alone — and with one option left there is nothing to pick, so on a
recording the control is not drawn at all. A document already holding a combination no
longer offered keeps it, and the picker comes back to show it until you change it — the
same courtesy an audio file carrying a visual retention marker gets.

`first frame` and `last frame` are the two the model has an input for: that block's image
is sent as the keyframe rather than as a reference beside one, so a transformation between
two stills is two blocks — the opening image used as `first frame`, the closing one as
`last frame`. There is nothing to wire; the node has no sockets for them.

All three define themselves by the frame they are rather than by what they are a picture
of, which is the shape MiniMax's guide asks for: *"<Picture 1> is the first frame of
[Shot 1]."* `retention_analysis` names the role a second time, beside the marker.

`keyframe` is the third of that group and the one with no input behind it. MiniMax's own
guide counts it as a frame anchor — `keyframe completion` is for *"an image [that] serves
as the target video's first frame, keyframe, last frame, edited keyframe, or another
concrete frame anchor"* — but that is a sentence in the prompt, and the ComfyUI node has
two arguments, `first_frame` and `last_frame`. So a picture that should be a frame in the
*middle* cannot be handed over as one: that block's image travels with the references,
and what `keyframe` changes is the text. The task type becomes
`keyframe completion` and `retention_analysis` writes `<Picture 1> ([Shot 2] keyframe)`
where a reference would read `(appears in [Shot 2])`. An end is a guarantee, because it is
an input; the middle is a request in the prompt, which the model follows loosely.

**A keyframe is fitted to the clip, not the other way round.** ComfyUI's core node scales
`first_frame` straight to `width` × `height` with cropping disabled, so a square photograph
in a 1280 × 832 clip comes out stretched. A block used as `first frame` or `last frame`
therefore carries a **`fit`** picker of its own, beside `keep file`:

| `fit` | What happens to a picture whose shape is not the clip's |
|---|---|
| `crop` | the default: scaled and cover-cropped from the centre, so proportions survive and an edge is lost |
| `stretch` | handed over untouched, which is core's own behaviour: every pixel kept, proportions squashed |

A picture already of the clip's shape is untouched either way, and says nothing. When the
shapes do disagree the report names both sizes and which edge went, or that the
proportions changed — whichever was asked for — and points at the two ways to have
neither: give the clip the picture's shape, or attach the file as a `reference`, which is
scaled aspect-preserving and lets the model compose the rest of the frame around it.
Nothing here can pad a keyframe and have the model invent the missing sides; that is
outpainting, and it belongs before H3 sees the file.

The settings row's **`default resize`** is the reference-side twin of this, and it sizes reference
*pictures* only: core reads it in its `ref_images` loop alone, so a reference video is
sized by its own canvas rule and a keyframe by `fit`. It stays live whatever the clip
carries: a control that greys itself out is one you have to work out the rule for, and the
rule here is already written on the control. A picture in the **Files** list counts even
before it is dragged onto a track: it is handed to the model in the same `ref_images` loop as one on a block,
so it is sized by this control too.

What it trades is detail against time. A reference picture becomes tokens the model reads
beside the prompt, and those tokens are re-read at every sampling step — more pixels, finer
detail, more time. `match` shrinks it to about the clip's pixel count: fast, enough for a
scene, a style, a mood. `max` allows 2048 px on the short side: slower, and what keeps a
face the same face. Neither enlarges a picture or changes its proportions.

**Each picture can answer for itself.** `resize` belongs to the **file**, not to the block
it sits on and not to the clip: it is offered on every picture's row in **Files**, and on a
picture block's FILE row beside `keep file`, and both write the same thing — the same
photograph on two blocks cannot be `max` in one and `match` in the other, because the model
is handed one copy of it either way. Left at `default`, the settings row decides. A clip
usually wants both answers — `max` on the face it has to keep, `match` on the mood board
behind it — and one value for the whole clip made that a choice between paying for detail
nobody needed and losing the detail that mattered. Core has one socket for this, so the
director sizes each picture itself and hands core pictures its own pass leaves alone.

**`resize` does not touch `width` and `height`.** Until build `2026-08-17·02:05` the clip
silently took the shape of the first reference picture whenever `resize` said `match`,
which made a model setting move two unrelated fields. Now a picture block carries **set
width & height**, beside `detach media`: press it and the clip's `width`/`height` are taken
from that file's own resolution, scaled down to a size H3 renders and rounded to multiples
of 32. It works for a keyframe too — which is exactly what the crop warning asks for, and
what the old behaviour never did.

`keep file` says how much of it survives. An **audio** file is graded in its own words,
because H3's format defines a different set for sound: `fully_copy` (this recording is the
finished soundtrack), `partially_copy`, `reference` (only the timbre or texture is
followed, the signal is not copied), `weak_reference`.

**What comes back is always synthesised.** MiniMax's own guide defines `fully_copy` as the
source audio serving as the clip's complete final track — but nothing hands the file
through. Every reference audio is *encoded into the conditioning* (`_encode_ref_audio` in
core's `nodes_minimax_h3.py`), and the soundtrack you get is the one the sampler produced
and `VAEDecodeAudio` decoded. So the marker states a target, not a guarantee, and it can
only be met when the recording covers the clip: a 3.4s file under an 8s clip leaves 4.6s
the model fills with sound of its own. If the actual recording has to be in the output,
wire the audio into `CreateVideo` instead of the decoded audio and the model's take is
discarded. Everything visible keeps
`fully_preserved` / `partially_preserved` / `attribute_transfer` / `weak_reference`. The
picker follows the file, so there is nothing to get wrong — and an older document holding
a visual marker on an audio file is translated rather than reset.

A dialogue row with no words in it dims — the row and its background both — so an empty
row reads as what it is: ignored by the compiler until you type something.

Along the bottom edge of a block sit its chips: the file it carries (`IMAGE · face.jpg`),
and one per transfer taken out of that file — `FACE → SPEAKER`, or amber `FACE → ?` while
nobody has been named to receive it. A face swap is a thing you can see on the timeline
rather than something buried in a card.

Two or more faces lit on **one** row is the guide's `(S1,S2)`: the same words spoken by
all of them at the same instant — Cmd/Ctrl-click each one after the first, since a plain
click is how you hand the line to one person instead. Three faces compile to `(S1,S2,S3)`;
there is no limit. Two rows is a conversation — they speak in turn. Speech with no agreed
words, an argument or a crowd, is neither: describe it in the segment prompt and put the
sound in an AUDIO cue.

**off-screen** makes the line a voiceover. MiniMax fixes both halves of that form and the
switch writes both: the exact phrase `says in an off-screen voiceover`, and the clause
that has to follow every one of them — *while their lips remain completely closed*. The
second half is the one people forget by hand, and without it the model animates a mouth
to match the words.

**carries over** says the line does not finish inside this block. With a shot after it,
both sides of the cut are marked `<scenetrans>` and the prompt states that the audio
continues across it; with nothing after it, the same switch compiles as `<cutoff>` —
speech truncated by the end of the clip — and the linter says so, in case that was not
what you meant. Write the two halves as two lines in two blocks and tick the first.

### WHO & WHAT

The **WHO & WHAT** tab is one card per thing the prompt has to name, and the tab itself
carries the count. Usually a person — but the guide's subjects are not only people: a
costume, a prop, a place or a style lifted out of the same photograph is a subject too,
with a retention marker of its own, and it fills in the same card with the voice row left
empty. Several cards may point at one file; that is how a single photograph names several
things, each numbered separately.

The list is as tall as the cards in it, and the node is as tall as whatever panel is open —
nothing here is a fixed height that clips. To give the list a height of its own, drag the
grip in its bottom-right corner — the node's own corner does not do it, because the node is
as tall as its content on every tab. The number is stored on the node and comes back with
the workflow. A height like that still makes room for a card you add — the box is re-sized to the whole
list, so a new card never arrives behind a scrollbar, whatever height was dragged.

Two tokens appear on every card, and they are MiniMax's, not ours:

- **`S1…Sn`** — a **speaker**: who says a line. The card supplies the voice; the words
  themselves are written on a shot's dialogue row. `S` is for speaker, which is why it is
  not `V`.
- **`<Subject 1…n>`** — a **subject**: a person, a costume, a prop, a place, a look the
  model must keep. A card is one only with a file **and** a description; without a file
  there is nothing on screen for the prompt to point at, so it can only be a voice and it
  shows a hollow `no <Subject>` in place of the token.

A card can be one, the other, or both. This is also the only place a file is described.
A card holds:

- **name it** — a short name, yours, so the chips on a dialogue row are readable
- **from** — which file on the timeline this subject is drawn from, if any, and the only
  place that file is described. The binding is what makes a face and a voice one person:
  the card then shows the `<Subject n>` badge the prompt will use. Several cards may point
  at one file — a person, their coat, the room behind them — each numbered separately.
- **what it is** — the sentence that becomes this subject's definition, and the only
  description of that file anywhere. A line under the box says which `<Subject n>` it
  became and that the file has no entry of its own. When the file's role does keep it an
  entry — a frame anchor, an edit source — this sentence fills that in too.
- **keep it** — how much of *the subject* survives, compiled as `subject_retention`. Not
  the same field as the block's `keep file`: the photo may be `fully_preserved` while the
  face taken out of it is an `attribute_transfer` onto somebody else. While a card
  describes a file whose `used as` is `reference`, the block's `keep file` goes dead —
  dimmed and dashed: MiniMax asks for a file used only to define something to be cited
  inside that thing's definition, so the file gets no entry of its own and this is the only
  marker the model sees.
- **onto** — who receives that transfer. It appears only when `keep it` is
  `attribute_transfer`, and it is what turns "a face" into a face swap: the pick list
  offers the other cards and each shot's subject, or you type a receiver the shot
  describes but no card names.

  **Picking a card folds this one into that card.** MiniMax's guide calls `<Subject N>`
  "a content unit that will actually be used in the target video", and says that when one
  subject comes from several assets you "combine the sources and state what each asset
  provides" — `<Subject 1> is the woman whose appearance comes from <Picture 1> and whose
  walking motion comes from <Video 1>`. A face is not a person; it is a second source for
  one. So the card takes no `<Subject n>` of its own — its badge reads `→ SPEAKER` — and
  the receiver's line becomes:

  ```
  <Subject 1> is the man in the navy suit: his build …, from <Picture 1>.
  <Subject 2> is the face: bone structure, eyes, nose and jawline, from <Picture 2>.

  … <Subject 1>'s face is replaced by <Subject 2>, from <Picture 2>, and nothing else
  about <Subject 1> changes.

  <Subject 1> (appears in [Shot 1]): partially_preserved - the man in the navy suit: his
  build … are retained from <Picture 1>; the face is not retained from <Picture 1> and
  comes from <Subject 2> instead.
  <Subject 2> (appears in [Shot 1]): attribute_transfer - the face … replaces
  <Subject 1>'s face only, mapped onto the same position and framing at every moment.

  [Shot 1] <Subject 2>, the face …, replaces <Subject 1>'s face and is mapped onto the
  same head, in the same position and framing, at every moment. <your shot prompt> …
  ```

  The receiver reads `partially_preserved` even when its card says `fully_preserved`:
  the guide defines that marker as content still used with some characteristics changed,
  and a person whose face is replaced is exactly that. `fully_preserved` beside a sentence
  excluding the face is a contradiction, and the model resolves it in favour of the
  marker. The shot opens with the replacement, before your own sentence, so the frame is
  never drawn as the original person first.

  **The incoming feature keeps its own subject, and it carries the marker.** That is the
  shape a working identity replacement uses: the thing being brought in is the
  `<Subject n>`, its retention line says what it overwrites *and* what it leaves alone,
  the receiver's line enumerates what its own picture supplies with the replaced region
  named as excluded, and the summary and the shot body both state the replacement.

  Two earlier shapes did not work, on three paid runs. Folding the feature into the
  receiver left the prompt with no subject to point at where the new face belonged.
  Before that, the face was `<Subject 2>` "transferred onto `<Subject 1>`" while
  `<Subject 1>` was `fully_preserved` over the whole person — one instruction to replace
  the face and one to keep it, and the model kept it. The photograph the feature
  comes out of keeps no entry of its own either: it is cited inside the definition it
  feeds, which is the same rule.

  **A reference video defeats all of this.** Measured over eight renders on 2026-08-31,
  the same 90-frame document each time: with a reference video on the timeline, H3 keeps
  that video's face and that video's voice, and no marker changes it. Four shapes were
  tried and all four came back with the original performer's face and a voice 30 Hz or
  more away from the reference recording -- the transfer `onto` the video's own card, the
  same with the swap restated and the face image sharpened, `motion from` so the video
  claimed nothing visual at all, and MiniMax's own documented swap with the video
  `partially_preserved` over framing, environment and full choreography. The same
  documents with the video taken off transferred the face and the voice both, twice over.
  So a face swap wants a **still** to replace, not a clip: put the person's photograph on
  the timeline and write the location, the wardrobe and the action into the prompt. The
  report says so before the run, on the transfer and on the voice reference alike.
  Two controls stop offering the run that fails: **onto** leaves out a card drawn from a
  reference video — typed prose still takes anything, because that box also names somebody
  the shot describes — and **voice from** goes dead while a reference video is on the
  timeline, unless it already names a recording, so a value the note asks you to clear is
  never locked in. A reference video used only for style, with the swap between two
  photographs, is untested and is warned about rather than prevented.


  Typed prose that names no card is left as written and still compiles as
  `…, transferred onto the woman at the desk` — there is no definition to fold into.
  Empty, the model is told to move a trait and never told where, and the block's chip
  stays amber. Either way, **describe the receiver without the feature being replaced**:
  `fully_preserved` on "the man … *his face* with visible pores" is an instruction to keep
  that face, and the report warns about it.
- **motion from** — a second file for the same person, supplying how they move rather than
  what it looks like. A still says nothing about a walk, so pointing the card at a video
  as well compiles as `<Subject 1> is the woman, whose appearance comes from <Picture 1>
  and whose motion comes from <Video 1>.` Shown once there is a video on the timeline.
- **what it is** — for a card with a file; becomes its `subject_definitions` line
- **how they sound** — age, gender, pitch, timbre, accent, on screen or off, and the
  speech switch as well: **a card speaks when this box has something in it**. H3 fixes the
  voice from what the prompt says about the speaker, so a line from somebody nobody
  described is a voice the model invents — and an invented one is worse than a line left
  out, so the lines wait rather than compile. For a card with a file it is written onto
  that subject's `subject_definitions` line
  (`… from <Picture 1>, and sounds like this: a man in his forties, warm and even.`),
  because the body names them by token; for a card with no file the body prints it before
  the `(Sn)` instead.
- **voice from** — or take the timbre from a recording instead of describing it. Point the
  card at an `<Audio n>` on the timeline and the prompt says
  `<Audio 1> is the voice-timbre reference for <Subject 1> (S1).`, with the file marked
  `reference`: the timbre and the delivery are followed, the signal itself is never
  copied. Setting that file's `keep file` to `fully_copy` asks for both at once, and the
  linter calls it what it is.

**A card that is doing nothing looks like it.** A card counts when it names a file *and*
says what that file is — that is a `<Subject n>` — or when it describes a voice something
actually speaks. Short of either, the compiled prompt is byte-for-byte what it would be
with no card there, so the card goes flat: transparent, dashed, dimmed, with the reason in
amber across it and the same line in `report`.

| The card says | Because |
|---|---|
| this card compiles to nothing | no file and no voice: neither a subject nor a speaker |
| nothing is written about `<Picture 1>` yet | a file is picked, but with nothing said about it the card takes no number |
| nobody speaks this card's lines | it has a voice, and no shot's dialogue row ticks its face |
| no file: this card gives a voice and nothing else | fine, and deliberate — a speaker with no photograph |

A green **`[Shot n]`** badge says where the card is heard, which is otherwise only visible
from the TIMELINE tab.

**There is no speech switch.** The voice box is the switch: a card that says how it sounds
speaks, and a card that says nothing is a subject and nothing else — a prop, a coat, a
place, and most people in most clips. Clear the box and that card stops speaking; its words
stay exactly where they are, on the blocks, out of the prompt, and typing a voice back
compiles all of them again. A line two cards share loses only the one that went quiet. The
recording in `voice from` counts as saying how they sound, and goes quiet with it — a timbre
reference for a speaker the model is never asked to voice is a statement about nothing.

Silence is never silent about itself: **`report` counts the lines that were left out**, by
card and by number, so words never leave the prompt without a sentence saying they did.

An empty box is drawn switched off — dimmed and dashed, with `S2` hollowed beside it — and
lights up the moment the caret lands in it, because typing in it is how a card starts
speaking. Leave it empty and it goes back. Nothing is hidden: taking the row away changed
the height of the card under the pointer and moved every card below it, and a panel that
jumps when you press something is one you stop trusting. With nobody left speaking, the
`S1…Sn` line of the legend fades too.

**Add** adds a card.

WHO & WHAT lives on the document rather than on each line because a speaker is not a property
of one shot. Describing the same `S1` two different ways in two blocks was possible before,
and to the model that reads as two people sharing one label.

Removing a speaker leaves the lines that used their number alone. Renumbering to close the
gap would quietly reassign every later line to a different person.

Double-click a block to edit its text in place. Drag its edges to resize, its middle to
move, and drag a box over several to select them together. Clicking one member of a
selection singles it out; `Cmd/Ctrl`-clicking one takes it out and leaves the rest. `Delete` removes the
selection; `Cmd/Ctrl+A` selects every block on every track; `S` cuts the selection in two
at the playhead; `Cmd/Ctrl+C` / `Cmd/Ctrl+V` copy and paste
it, keeping its spacing; `Cmd/Ctrl+Z` undoes.

**Clear** in the toolbar empties the piece — every block, the global prompt, the music and
every card on WHO & WHAT, because a card left behind points `from` at a file that is no
longer on the timeline. One undo step puts the timeline back; the cards are a document of
their own and do not come back with it.

The red playhead is the timeline's one landmark. Click empty track to move it, and it
becomes where new blocks land, what a drag snaps to, and what `+` / `-` zoom around.

---

## The frame lattice, and why lengths jump

H3 only accepts clip lengths satisfying `length % 17 == 5`, at a fixed 24 fps:

```
5, 22, 39, 56, 73, 90, 107, 124, 141, 158, 175, ...
```

**Where the 17 comes from.** The model does not denoise frames; it denoises a latent — a
compressed video whose time axis is a row of slots. H3's video VAE packs **17 frames into
5 slots**, after a 5-frame head that costs 2, which ComfyUI writes as
`((frames - 5) // 17) * 5 + 2` (`comfy_extras/nodes_minimax_h3.py`). Decoding runs the
other way: each slot becomes 3.4 frames. A length off the lattice would need a fraction of
a slot, which cannot exist, so 124 frames is 37 slots and 130 frames is nothing at all.

Only **8s (192 f), 25s (600 f) and 42s (1008 f)** land on whole seconds.

The editor always rounds **up**, never down, and does it while you build rather than at
render time: see *Duration comes first* above.

The trained range is roughly **124–362 frames** (5.2–15.1s). Shorter and longer are
accepted by the node but untested.

---

## References: `<Picture 1>` and friends

H3 addresses reference material from inside the prose. A picture that nothing points at
is a picture the model ignores.

Attach a file to a block and the token is appended to that block's line for you. You do
not need to type it — and if you do type it, it is not added twice.

The numbering is **presentation order**, not slot order:

1. every image, in timeline order — `<Picture 1>`, `<Picture 2>`, …
2. then each video, preceded by its own soundtrack's `<Audio j>`
3. then standalone audio, continuing the same `j`

So one video with sound plus one standalone clip gives `<Audio 1>` (the soundtrack),
`<Video 1>`, `<Audio 2>`. Getting this wrong does not crash anything — it generates the
wrong video, quietly. The `prompt` output shows the numbering that was actually used.

Limits, from the model card and the platform API: **9 reference images, 3 videos and 3
audio files**, with **15 seconds** of video and of audio in total and **12 files**
across all three. A video's own soundtrack is not a file of its own and does not count
against the audio three. Frame anchors are counted apart, because they are handed to
the keyframe inputs rather than to the reference list — and the two cannot be combined
at all: MiniMax documents reference mode and first/last-frame mode as mutually
exclusive, and the director refuses a timeline holding both. Each picture also has to sit
within **256–5760 px** on both sides and a **0.4–2.5** width-to-tall ratio, which is why a
panorama is refused rather than letter-boxed.

Two of these are caught before the file lands. **Shape and clip length belong to the
file** — they are settled when it is picked and never change — so a picture outside the
bounds, or a recording outside 2–15 s, is refused at the moment it is chosen and says why
in a dialog over the editor; nothing is placed. Once a file has a block, a card and a
token, taking it back is work. **The counts cannot be caught there**, because switching a
`first frame` back to `reference` reaches ten pictures with no button pressed: the three
media buttons go dim and dashed once their bucket is full — pressing one anyway says how
many are already held rather than doing nothing — and `report` is the guard that actually
holds.

Every refusal the editor makes goes to that same dialog: the shape and length above, a
bucket already full, a file that is not a picture, a recording or a clip, and an upload
that fails. It is dismissed with OK, Escape, or a click outside it.

**A picture that only exists to define somebody gets no entry of its own.** MiniMax's
guide is explicit: if an image is used only to establish a character, a scene, a costume
or a style, cite it inside the `<Subject n>` definition instead of writing a standalone
picture entry. So a `reference` image whose whole job is feeding a subject card is described
once, as the subject drawn from it — asking for the picture *and* the person is asking for
two different things at once. An image used as a `first frame` keeps its own entry either
way: it is a real frame of the target video, whoever else it defines.

---

## Camera moves

A move is three choices, which is how MiniMax documents it: **motion type**, **amplitude**
and **speed**. H3 reads prose, not enum values, so the three become one sentence.

| Motion | Sentence sent |
|---|---|
| `— in words` | *nothing* — the note is the whole camera line |
| `static` | The camera holds a static shot. |
| `zoom_in` / `zoom_out` | The camera zooms in / out. |
| `dolly_in` / `dolly_out` | The camera pushes in / pulls out. |
| `pan_left` / `pan_right` | The camera pans left / right. |
| `truck_left` / `truck_right` | The camera trucks left / right. |
| `tilt_up` / `tilt_down` | The camera tilts up / down. |
| `pedestal_up` / `pedestal_down` | The camera rises straight up / lowers straight down. |
| `orbit` | The camera moves in an arc around the subject. |
| `tracking` | The camera follows the moving subject. |
| `pov` | The camera takes the subject's point of view. |
| `roll_cw` / `roll_ccw` | The camera rolls clockwise / counterclockwise. |
| `handheld` | The camera shakes slightly. |
| `shake_strongly` | The camera shakes strongly. |

Zoom and push-in are not the same move. A zoom changes the focal length with the camera
standing still; a push-in moves the camera body, and the background changes size with the
subject. The model knows the difference, so it is worth picking the right one.

**amplitude** (`small` / `large`) and **speed** (`slow` / `fast`) are added to the
sentence when set: `dolly_in` + `small` + `slow` compiles as *"The camera pushes in with
small amplitude at slow speed."* Both default to *medium* and *normal*, which the guide
writes by leaving them out — so those options add nothing, on purpose.

A note typed into the block is appended after the sentence: `dolly_in` + *"closing on the
apple"* becomes *"The camera pushes in. closing on the apple"* — write it as a
continuation, not as a sentence of its own.

Twenty words do not cover every camera, and the first option in the list — **`— in
words`** — is for the ones they miss: it writes no sentence at all, so the note becomes the
whole camera line, in your words. `static` is not that option; picked beside a described
move it compiles to a contradiction — *"The camera holds a static shot. The camera drifts
along the tabletop."* Amplitude and speed are not offered with `— in words`, for the same
reason they are not offered with `static`: there is no verb for them to qualify.

Documents from before amplitude and speed were fields are read as what they meant:
`dolly_in` was always *small, slow* and the retired `crash_zoom` always *large, fast*, so both keep
those values on load and compile to exactly the sentence they always did.

A camera block is written into whichever shots it overlaps. It stays a separate track in
the editor because a move can straddle a cut, but the prompt puts the sentence inside the
shot, which is where the model reads it.

---

## What the compiler writes

MiniMax publishes the prompt format in
[`VIDEO_PROMPT_WRITING_GUIDE_base_en.md`](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md).
It is three fields, not a set of labelled blocks, and this is what you get:

```
integrated_multimodal_description: [Shot 1] Locked-off studio shot. A single red apple
sits alone on the table. <Picture 1>. The camera pushes in with small amplitude at slow
speed. [Shot 2] At 00:01.708, the camera cuts to A single blue cube sits alone on the
table. <Picture 2>.

overall_soundscape: One clear bell chime, then silence.

non_diegetic_music: Sparse piano notes at a slow tempo.
```

Three consequences worth knowing:

- **Camera work is written inside its shot**, not in a section of its own.
- **The first shot has no timestamp**; later ones open with their cut time.
- **Audio has two fields.** `overall_soundscape` is everything the characters can hear;
  the MUSIC box is `non_diegetic_music`, the score only the audience hears, and compiles
  to `N/A` when empty.

Attach a file and the prompt switches to H3's six-section full-reference format instead —
`subject_definitions`, `summary`, `retention_analysis`, `detailed_description`,
`overall_soundscape`, `non_diegetic_music`. The shot list is the same string under a
different name, with one difference the guide asks for: the GLOBAL PROMPT is stated on its
own line **above** `[Shot 1]` rather than folded into it.

**Paste anything you like.** Line breaks in the format mean something — `subject_definitions`
and `retention_analysis` list one entry per line, and a blank line starts a new field — so
every box you type or paste into is flattened to a single line on the way out. A paragraph
copied from a document arrives as one sentence with single spaces, not as an extra subject
the model was never told about.

---

## The outputs

| Output | Use |
|---|---|
| `positive` | into `BasicGuider` |
| `latent` | into `SamplerCustomAdvanced` |
| `prompt` | **read this** — the exact string the model receives |
| `report` | linter findings: unmentioned references, gaps, overlaps, padding added |

There is no `length` output. The frame count after rounding is on the timeline's clock
and in the `latent` the sampler receives, so a socket for it was a third copy of one
number.

Both are already wired in the shipped workflow: the compiled prompt to the right of the
director, the linter's findings underneath it. Almost every "why did it do that" question
is answered by looking at those two panels.

`report` also carries the checks MiniMax's guides hand out for free, each a warning and
never a refusal:

- the description outside the **350–500 words** the guide asks for on a generation task —
  skipped for dialogue-heavy clips and for editing tasks, which it exempts by name
- two adjacent shots that **describe the same thing at a different framing**; the guide
  asks for a camera move rather than a cut when only the distance changes
- an empty AUDIO track, because `overall_soundscape: N/A` tells H3 the clip is
  **completely silent**, which is a stronger claim than "nobody wrote anything yet"
- a **standalone voice reference** whose `keep file` asks for the recording to be copied.
  A reference video's own soundtrack is not checked: the video and its sound are one file
  row, so that `keep` is the picture's and there is nothing separate to set for the sound
- a line marked **carries over** with nothing after it, which compiles as `<cutoff>`
- a **guessed word** in a reused line — the guide wants `[unclear]`, never a guess
- a **subject card that compiles to nothing**: no file, so it is not a `<Subject n>`,
  and no voice, so it is never heard. The card is a filled-in row either way
- **written lines that are not compiled**: the card they belong to describes no voice, so
  it does not speak, and the report says how many words are waiting on that box
- the reverse: a card with a **voice nobody speaks with** — no line names its `S`, so
  the voice instructs nothing, and a `voice from` recording is named as the timbre
  reference for a speaker the model is never asked to voice

---

## The other two nodes

**MiniMax Director — Prompt** and **MiniMax Director — Report** show the compiled prompt
and the linter's findings while you write, without running anything. Both are already in
the shipped workflow. They exist rather than a generic preview node for one reason: a
preview fills from a *run*, and a warning that arrives after the render arrives after the
cost.

Each carries a **copy** button in its top right, which puts the whole panel on the clipboard
— the prompt to file with a render or paste into a conversation, the report to send with a
question. It falls back to the old copy command on a pod reached over plain `http`, where the
browser gives a page no clipboard API at all.

That is the whole pack: three nodes, all three in the shipped workflow. Earlier releases
also carried a **Compile** node (the compile step with no model attached) and a **Length**
node (seconds to a legal frame count). Both were for wiring a graph by hand. The timeline's
clock already reads the frame count in frames and seconds, and the editor already compiles
and lints on every edit pause, so each was a second way to reach something that was on
screen already.

---

## When something looks wrong

**The clip is a different length than I asked for.** It was rounded up to the lattice.
`report` says by how much.

**My reference image is ignored.** The prose has to point at it. Check `prompt` for the
`<Picture n>` token, and check the number matches the image you meant.

**Everything is one continuous shot.** That is the model, not the node — check `prompt`
to confirm the shot list is really there, with a cut time opening every shot after the
first.

**The video looks fine but there is no sound.** The audio VAE is not connected, or the
latent only reaches `VAEDecode`. Both decoders take the *same* latent.

**A block won't get longer by dragging.** It has hit the end of the clip or a neighbour.
Type the length instead — typing grows the clip; dragging does not.

**The node won't get shorter.** It is already as short as its content. Right-click →
**Fit node to content** confirms it: if nothing moves, that is the floor. Close a panel or
remove a block to go lower.

**Dragging the node's corner does nothing.** Another node is sitting over that corner —
the press lands on whichever node is on top. Move it, or drag a corner that is clear.

---

## What is measured, and what is not

Tested against real weights on 2026-08-05, one clip:

- **Shot order works.** Three shots with a reference image each came out in the written
  order, with the right subject in each.
- **Cuts are approximate.** One boundary landed a frame early, the other nine frames
  late. Do not plan on frame-accurate cuts.
- **Per-segment camera does not work.** A segment asking for `static` pushed in anyway,
  and moved more than the segment that asked for a dolly. Treat the camera track as a
  hint about the whole clip, not a per-span instruction.
- **Audio cues land when they sit inside one shot.** A cue confined to a single shot is
  written into that shot and arrives there: a bell asked for in the first 1.7s fired at
  0.064s and nowhere else. A cue spanning several shots becomes untimed ambience, and the
  model will place it where it likes -- earlier runs put it on the cuts.

Both failures were traced to the prompt format: the compiler was emitting `Camera:` and
`Audio:` blocks, which are this project's invention and not labels H3 is trained on. It
now emits MiniMax's documented three-field format instead. **That fix has not itself been
tested on a GPU** — it is reasoned from the official guide, not measured.

Still untested: `non_diegetic_music` (the MUSIC box has been empty in every run so far),
whether `ref_image_size: match` behaves as its tooltip says, and behaviour outside the
trained length range. `AGENTS.md` keeps the current version of that list.
