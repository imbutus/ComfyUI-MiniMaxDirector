# The node's height: what is there now, why it blinks, and what to do about it

Written after dragging the node's own corner made it flicker. Everything below is read
off the code, with file and line references; the proposals at the end are proposals, not
changes.

---

## The rule the design already has

**The node is exactly as tall as its content.** `fitPulled` (`web/minimax_director.js:95`)
measures the editor and calls `node.setSize`. There is no remembered node height, and the
comment there says so outright: a list that absorbed spare room, a remembered panel
height and a "may grow, never shrink" rule were three answers to a question with one.

That rule is good. The trouble is not the rule — it is that **six different things call
it, one of them is the user's own hand, and the answer arrives a frame late.**

---

## Everything that writes a height today

| # | Where | Trigger | Writes |
|---|---|---|---|
| 1 | `pullUp` → `onDrawForeground` (`minimax_director.js:117`) | every canvas frame | `widget.y`, `widget.computedHeight`, and `fitPulled` for the first 3 learned frames |
| 2 | `fitPulled` (`:95`) | called by 3–7 | `node.setSize` |
| 3 | `node.onResize` (`:347`) | the user drags the node corner | clamps `size[1]` back to the content, in the same frame, on every tab (**proposal 1a, applied**) |
| 4 | `growWithPrompts` (`:664`) | a `ResizeObserver` per child of `editor.root` | `fitPulled` |
| 5 | `cast.onResize` (`:261`) | every cast render | `fitPulled` |
| 6 | `editor.onTab` (`:264`) | tab switch, and now the Files toggle | `fitPulled` twice, on two rAFs |
| 7 | `fitAfterLoad` (`:529`) | `onConfigure` | `fitPulled` |
| 8 | `setListHeight` (`:66`) | the cast grip drag, and nothing else | `node.properties.castHeight`, `box.style.height` |
| 9 | `pairHeights` (`editor.js:884`) | a `ResizeObserver` on the two global textareas | the other box's `style.height` |
| 10 | the browser | `resize: vertical` on every prompt textarea | inline `style.height`, which wakes #4 |

Two heights are actually **stored**: `node.properties.castHeight`, and the inline heights
the browser writes on dragged textareas. Everything else is derived — recomputed from
scratch, from ten places.

---

## Why it blinks

Drag the node's bottom-right corner on the TIMELINE tab:

1. litegraph writes `node.size[1]` and repaints — the node is now taller.
2. `node.onResize` fires and schedules a `requestAnimationFrame`.
3. On the next frame `fitPulled` measures the content and sets the height **back**.
4. The pointer has moved, so litegraph writes a taller size again.

One frame tall, one frame short, for as long as the drag lasts. The snap-back is
intended — on TIMELINE there is nothing to give the extra room to — but it is applied
*one frame late*, and a correction that lands a frame late is a flicker rather than a
refusal. On the WHO & WHAT tab the same gesture did not blink, because there the difference
was given to the card list and the fit then agreed with the drag -- which is also why that
one tab kept resizing after every other one stopped.

Two smaller aggravations sit behind the same seam:

- **Measuring mutates.** `contentHeightOf` (`:77`) sets `root.style.height = "auto"`,
  reads `scrollHeight`, and puts the old value back. That is a forced reflow every call,
  and it perturbs exactly the layout `growWithPrompts` is watching — which is why the
  `editor.measuring` flag exists at all. A flag whose only job is to stop our own observers
  reacting to our own measurement is a sign the measurement is doing too much.
- **Fits come in pairs.** `onTab` fits on two consecutive frames, `attach` fits twice
  after the first render, `pullUp` fits three times. Each is a real fix for "the widget's
  height follows one frame later", and each is also a second and third opportunity to
  disagree with something.

---

## Proposals

Ordered by how much they buy per line changed. They are independent; 1 alone stops the
blinking.

### 1. Decide what the corner drag *means*, and answer in the same frame

The blink is a one-frame argument. Either end it immediately or stop having it:

- **1a — refuse it, synchronously.** In `node.onResize`, clamp `node.size[1]` to the
  content height *inside the handler* rather than in a `requestAnimationFrame`. The node
  stops following the pointer vertically and never flashes; the drag still works
  horizontally, which is the dimension that matters for a timeline.
- **1b — honour it.** Store `node.properties.extraHeight = node.size[1] - content` on
  drag, and make the fit `content + extraHeight`. Give the slack to the timeline stage the
  way the cast tab gives it to the card list — more tracks visible is a real thing to want
  from a taller director. This is more work and adds a second stored number, but it makes a
  gesture that currently does nothing do the obvious thing.

**1a is what was taken**, on every tab. It is a handful of lines, it removes a state
variable rather than adding one, and it keeps the "content decides" rule the whole design
rests on. The cast branch went with it, so one gesture no longer means two things depending
on which panel is open: the card list is given a height by the grip in its own corner, and
that is the only way.

### 2. One writer, one queue

Make `fitPulled` private to a single `scheduleFit()` that coalesces on one rAF, and route
every trigger (3–7 above) through it. A burst of six calls in one frame — which is what a
tab switch plus a render plus two observers actually produce — becomes one measurement and
one `setSize`. The doubled fits in `onTab`, `attach` and `pullUp` can then go, because the
queue naturally re-runs on the frame after a size change if the measurement moved.

### 3. Measure without mutating, and delete the `measuring` flag

Give `.mmd` `height: auto` and read `root.getBoundingClientRect().height` — or measure a
single inner wrapper that is never given an explicit height. Nothing writes to the DOM to
take a measurement, so no observer fires because of it, so the flag that suppresses them
is unnecessary. This also removes the forced reflow from a path that runs on tab switches
and on every observed resize.

### 4. One observer, not one per child

`growWithPrompts` installs a `ResizeObserver` per child of `editor.root`, and the children
change as panels are rebuilt. One observer on `editor.root` with `box: "border-box"`
reports the same information — the thing being asked is "did my content get taller?" — and
survives any future panel without being re-installed.

### 5. Name the two stored heights in one place

After 1a there is exactly one: `castHeight`. After 1b there are two. Either way they
deserve a short block at the top of `minimax_director.js` saying *these are the only
heights anybody stores; everything else is measured*. The file already argues this in three
separate comments, which is how it stops being true.

---

## What not to change

- **The pull-up over the socket band.** It looks exotic, but the comment at `:41` is
  correct: `widget.y` written from a node callback is undone by the same frame's layout
  pass, so writing it on the canvas callback is the only place it survives. Leave it.
- **`castHeight` living in `node.properties`.** A height the author chose belongs to the
  workflow, not to the session.
- **The "content decides" rule itself.** Every proposal above keeps it.
