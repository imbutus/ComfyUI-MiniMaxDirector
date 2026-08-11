/**
 * Styles for the timeline editor, injected once.
 *
 * A DOM widget renders outside ComfyUI's canvas, so it needs its own styling. Colours
 * are hard-wired rather than inherited: ComfyUI themes vary, and a timeline whose track
 * colours drift with the theme stops being readable at a glance.
 *
 * Every class is prefixed `mmd-`, and that is load-bearing rather than tidiness.
 * ComfyUI ships utility classes, and a plain `.fixed` here inherited its
 * `position: fixed` -- the element left the flow and printed on top of its own label.
 * A descendant selector does not save you: it only wins for properties it declares.
 */

const CSS = `
/* overflow:hidden here is a backstop, not layout. ComfyUI does not clip a DOM widget to
   its node, so anything inside that grows taller than the height the node granted is
   drawn over the graph below -- other nodes and all. The editor is meant to make the node
   fit its content instead (see fitNode), and when that fails the content should be cut
   off at the node border rather than land on top of somebody's sampler. */
.mmd { display:flex; flex-direction:column; gap:7px; width:100%; height:100%;
  overflow:hidden; font:12px/1.4 system-ui,sans-serif; color:#e5e7eb;
  box-sizing:border-box; }

/* toolbar ---------------------------------------------------------------- */
.mmd-bar { display:flex; align-items:center; gap:6px; flex:0 0 auto; flex-wrap:wrap; }
.mmd-bar button { background:#2c313c; color:#e5e7eb; border:1px solid #3a4150;
  border-radius:5px; padding:5px 11px; cursor:pointer; font:inherit;
  display:inline-flex; align-items:center; gap:6px; }
.mmd-icon { width:14px; height:14px; flex:0 0 auto; }
.mmd-bar button.mmd-danger { background:#3a2422; border-color:#5c332d; }

/* interaction states -----------------------------------------------------
   Everything clickable answers to the pointer. Without this the toolbar reads
   as a row of labels rather than controls. */
.mmd-bar button, .mmd-transport button, .mmd-seg-fields button {
  transition:background .12s ease, border-color .12s ease, color .12s ease; }
.mmd-bar button:hover, .mmd-transport button:hover {
  background:#3d4553; border-color:#5a6474; color:#fff; }
.mmd-bar button:active, .mmd-transport button:active {
  background:#232833; border-color:#4b5563; }
.mmd-bar button.mmd-danger:hover { background:#5a3029; border-color:#8a4238; color:#ffe7e3; }
.mmd-bar button.mmd-danger:active { background:#3a2422; }
.mmd-seg-fields button:hover { background:#5a3029; border-color:#8a4238; }

.mmd-settings input, .mmd-settings select,
.mmd-seg-fields input, .mmd-seg-fields select {
  transition:border-color .12s ease, background .12s ease; }
.mmd-settings input:hover, .mmd-settings select:hover,
.mmd-seg-fields input:hover, .mmd-seg-fields select:hover { border-color:#4b5563; }
.mmd-settings input:focus, .mmd-settings select:focus,
.mmd-seg-fields input:focus, .mmd-seg-fields select:focus,
.mmd-prompt textarea:focus { border-color:#6ea8c4; outline:none; }
/* A span, not a read-only input. An input is a box with a width, so the number sat at one
   end of it and its unit at the other -- and every rule written to take the box away lost
   to the generic .mmd-seg-fields input rule below, which is just as specific and comes
   later. A span is exactly as wide as its number, so the unit sits against it. */
.mmd-mirror { color:#cbd5e1; font-variant-numeric:tabular-nums; }
/* The gap belongs between a label and its control, not between a number and its unit --
   "5.17 s" is one reading, and a flex gap put air in the middle of it. So the row runs at
   gap 0 and the controls carry their own left margin; a unit, following its value, gets
   none and sits against it. */
.mmd-settings label > input, .mmd-settings label > select,
.mmd-settings label > .mmd-value, .mmd-settings label > .mmd-mirror,
.mmd-seg-fields label > input, .mmd-seg-fields label > select,
.mmd-seg-fields label > .mmd-mirror { margin-left:5px; }
/* A mirror is its own label, so the row gap -- meant to separate one field from the next --
   landed to the left of its equals sign and made the reading straddle two fields' worth of
   air. Pulled back to the same single space that sits on the other side of the sign. */
/* The row gap is cancelled outright, and both spaces around the sign then come from one
   declaration on the sign itself. Splitting them -- gap on the left, margin on the right --
   is what made them drift: two numbers that have to stay equal, in two places. */
.mmd-settings .mmd-f-locked { margin-left:-12px; }
.mmd-seg-fields .mmd-f-locked { margin-left:-9px; }
.mmd-f-locked > .mmd-key { margin:0 4px; }
.mmd-settings .mmd-f-locked > .mmd-mirror,
.mmd-seg-fields .mmd-f-locked > .mmd-mirror { margin-left:0; }
.mmd-f-locked > .mmd-unit { margin-left:0; }
/* One box for everything about speech, with a switch on it. Off, the body goes away
   entirely rather than greying out: a disabled form still asks to be read. */
.mmd-switch { display:flex; align-items:center; gap:7px; cursor:pointer; }
.mmd-switch input { margin:0; cursor:pointer; accent-color:#6ea8c4; }
.mmd-cast-box.mmd-off .mmd-cast-body { display:none; }

/* The cast: a short list of people, not a form. Numbered on the left so the number in the
   block's picker and the number here are visibly the same thing. */
.mmd-cast { display:flex; flex-direction:column; gap:4px; margin-top:6px; }
.mmd-cast-row { display:flex; align-items:center; gap:7px; }
.mmd-cast-n { flex:0 0 auto; min-width:16px; text-align:center; font-size:11px;
  color:#9ca3af; font-variant-numeric:tabular-nums; }
.mmd-cast-row input { flex:1 1 auto; background:#1c1f26; color:#e5e7eb;
  border:1px solid #333a45; border-radius:5px; padding:4px 7px; font:inherit; }
.mmd-cast-row input:hover { border-color:#4b5563; }
.mmd-cast-row input:focus { border-color:#6ea8c4; outline:none; }
.mmd-cast-is { flex:0 0 auto; display:flex; align-items:center; gap:5px; color:#6b7280;
  font-size:11px; }
.mmd-cast-is select { background:#1c1f26; color:#e5e7eb; border:1px solid #333a45;
  border-radius:5px; padding:3px 5px; font:inherit; font-size:11px; max-width:230px;
  cursor:pointer; }
.mmd-cast-is select:hover { border-color:#4b5563; }
.mmd-cast-drop { flex:0 0 auto; background:transparent; color:#6b7280; border:0;
  cursor:pointer; font:inherit; padding:2px 5px; border-radius:4px; }
.mmd-cast-drop:hover { background:#3a2422; color:#f3d3cf; }
.mmd-cast-empty { color:#6b7280; font-size:11px; padding:2px 0; }
.mmd-cast-add { align-self:flex-start; margin-top:5px; background:#2c313c; color:#e5e7eb;
  border:1px solid #3a4150; border-radius:5px; padding:4px 9px; cursor:pointer;
  font:inherit; font-size:11px; }
.mmd-cast-add:hover { background:#3d4553; border-color:#5a6474; }
.mmd-prompt { transition:border-color .12s ease; }
.mmd-prompt:focus-within { border-color:#3f5a6b; }
.mmd-bar .mmd-preset { background:#2c313c; color:#e5e7eb; border:1px solid #3a4150;
  border-radius:5px; padding:5px 8px; font:inherit; cursor:pointer; }
.mmd-bar .mmd-preset:hover { background:#3d4553; border-color:#5a6474; }
.mmd-bar .mmd-grow { flex:1; }
.mmd-bar .mmd-len { color:#9ca3af; font-variant-numeric:tabular-nums; }

/* stage: fixed label column + scrolling track area ------------------------ */
/* The stage is exactly as tall as its tracks. Letting it absorb the leftover height
   left a field of empty grey under the last track, and made the prompt boxes fight the
   timeline for room instead of the node simply being the size it needs. */
.mmd-stage { flex:0 0 auto; display:flex;
  background:#15181e; border:1px solid #2c313c; border-radius:6px; overflow:hidden; }
.mmd-labels { flex:0 0 92px; padding-top:26px; border-right:1px solid #2c313c;
  background:#181c23; }
.mmd-label { height:62px; margin-bottom:6px; display:flex; align-items:center;
  justify-content:center; font-size:10px; letter-spacing:.09em; color:#8b93a1; }
.mmd-scroll { flex:1 1 auto; overflow-x:auto; overflow-y:hidden; position:relative;
  min-width:0; }
.mmd-canvas { position:relative; min-width:100%; padding-bottom:4px; }

.mmd-ruler { position:relative; height:22px; border-bottom:1px solid #262b34; }
.mmd-ruler span { position:absolute; top:0; font-size:9px; color:#6b7280;
  border-left:1px solid #333a45; padding-left:3px; height:100%;
  font-variant-numeric:tabular-nums; }

.mmd-track { position:relative; height:62px; margin-bottom:6px; margin-top:4px;
  background:#1c1f26; border-top:1px solid #22262e; border-bottom:1px solid #22262e; }

.mmd-end { position:absolute; top:0; bottom:0; width:1px; z-index:4;
  border-left:1px dashed #4b5563; pointer-events:none; }

.mmd-playhead { position:absolute; top:0; bottom:0; width:2px; background:#e2564b;
  pointer-events:none; z-index:5; }
/* A handle you can actually hit. The head was a 10px CSS triangle drawn with borders --
   nothing to grab, and nothing about it said it could be moved. This is a real element,
   wide enough for a pointer, with the cursor that promises a horizontal drag. The ruler
   was made taller to hold it (and .mmd-labels' padding with it, or the tracks stop lining
   up with their names). */
.mmd-head-grip { position:absolute; top:0; left:-8px; width:18px; height:15px;
  background:#e2564b; border-radius:3px 3px 7px 7px; pointer-events:auto;
  cursor:ew-resize; z-index:6; }
.mmd-head-grip::after { content:""; position:absolute; left:50%; top:4px;
  width:1px; height:7px; margin-left:-2px; background:rgba(0,0,0,.45);
  box-shadow:3px 0 0 rgba(0,0,0,.45); }
.mmd-head-grip:hover { background:#ee6a5f; }

/* segments --------------------------------------------------------------- */
/* The outline is an inset shadow, not a border, on purpose. A border creates a padding
   box one pixel inside the element, so a grip pinned to right:0 lands on that inner edge
   -- leaving a hairline of the block that answers to the parent's grab cursor instead of
   the grip's resize cursor. A shadow paints the same line without moving anything. */
.mmd-seg { position:absolute; top:3px; bottom:3px; border-radius:4px; cursor:grab;
  overflow:hidden; box-sizing:border-box; user-select:none;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.35); }
.mmd-seg { transition:filter .12s ease; }
.mmd:not(.mmd-dragging) .mmd-seg:hover { filter:brightness(1.18); }
/* Held, the block stays lit whether or not the pointer is still over it. */
.mmd-dragging .mmd-seg.mmd-resizing { filter:brightness(1.18); }
.mmd-seg:active { cursor:grabbing; }
/* Black, white, black -- the same trick the captions use, and for the same reason: a
   block's background is whatever image was dropped on it, and a plain light ring vanished
   on a white one. Inset shadows rather than an outline, so the blue "this edge would
   resize" ring can still use the outline property without the two fighting over it. */
.mmd-seg.mmd-sel { z-index:3;
  box-shadow: inset 0 0 0 1px #000, inset 0 0 0 3px #fff, inset 0 0 0 4px #000; }
/* The resize handles stay invisible until the pointer is on the segment, then show
   where the edges are rather than making the user hunt for them. */
.mmd-seg .mmd-grip { background:transparent; transition:background .12s ease; }
.mmd:not(.mmd-dragging) .mmd-seg:hover .mmd-grip { background:rgba(255,255,255,.22); }
.mmd:not(.mmd-dragging) .mmd-seg .mmd-grip:hover { background:#6ea8c4; }
.mmd-dragging .mmd-seg.mmd-resizing .mmd-grip { background:#6ea8c4; }

/* Touching blocks put two handles side by side. Outlining the whole block whose edge is
   under the pointer says which one a drag would resize -- the handles alone are 7px of
   near-identical highlight and give no answer. */
/* Hover only answers "which block would a drag take?", so it is switched off once the
   answer is settled. Held down, the pointer crosses in and out of a 7px grip constantly
   and the outline strobed with it. */
.mmd:not(.mmd-dragging) .mmd-seg:has(.mmd-grip:hover), .mmd-seg.mmd-resizing {
  outline:2px solid #6ea8c4; outline-offset:-2px; z-index:4; }
.mmd-dragging .mmd-seg { cursor:inherit; }
.mmd-seg.mmd-resizing .mmd-grip.mmd-l, .mmd-seg.mmd-resizing .mmd-grip.mmd-r {
  background:#6ea8c4; }
/* White on a black outline rather than white on a drop shadow. A block's background is the
   attached image when it has one, so the text sits on whatever that frame happens to be --
   a shadow disappears into a dark photo and the caption with it. The outline is drawn by
   paint-order:stroke under the fill, so the letters keep their shape at 11px; the shadow
   stays as a second layer for the blur a hard stroke does not give. */
.mmd-seg .mmd-cap { position:absolute; left:6px; right:6px; top:5px; font-size:11px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#fff;
  -webkit-text-stroke:2.5px #000; paint-order:stroke fill;
  text-shadow:0 1px 3px rgba(0,0,0,.9); pointer-events:none; }
.mmd-seg .mmd-chip { position:absolute; left:0; bottom:0; padding:1px 5px; font-size:9px;
  background:rgba(0,0,0,.72); color:#fff; border-top-right-radius:4px;
  max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  pointer-events:none; }
/* A control shares the bottom row, so the filename gives it the corner rather than running
   underneath it. */
.mmd-seg:has(.mmd-cam-pick) .mmd-chip { max-width:calc(100% - 118px); }
.mmd-seg:has(.mmd-keep-pick) .mmd-chip { max-width:calc(100% - 150px); }
/* The camera chip is a control, not a label, so it takes clicks -- the media chip stays
   transparent to them so a click there still grabs the block. */
/* A real dropdown, always on the block, so the move is both readable and changeable
   without selecting the block first. Bottom right, opposite the media chip: the left
   edge is where a block's start time is read off the ruler. */
/* The keep picker sits in the same corner on a block carrying a file: it is the other field that
   changes what the model is told to do with the block, and a camera block never holds
   media, so the two never want the corner at once. */
.mmd-cam-pick, .mmd-keep-pick { position:absolute; right:3px; bottom:3px; z-index:5;
  pointer-events:auto;
  cursor:pointer; font:inherit; font-size:11px; max-width:calc(100% - 6px);
  padding:2px 4px; background:#1c1f26; color:#e5e7eb; border:1px solid #4a5262;
  border-radius:4px; }
.mmd-cam-pick:hover, .mmd-keep-pick:hover { border-color:#6b7484; background:#232733; }
.mmd-cam-pick:focus, .mmd-keep-pick:focus { outline:none; border-color:#8b93a1; }
.mmd-seg .mmd-grip { position:absolute; top:0; bottom:0; width:7px; cursor:ew-resize; }
.mmd-seg .mmd-grip.mmd-l { left:0; } .mmd-seg .mmd-grip.mmd-r { right:0; }
.mmd-seg .mmd-media { position:absolute; inset:0; width:100%; height:100%;
  object-fit:cover; pointer-events:none; }
/* One layout for every block, whatever it carries: the prompt on the top line, the file on
   the bottom line, controls in the bottom right corner. Attaching a file used to move the
   prompt down onto the filename's row, which read as the file name being replaced by the
   prompt rather than the two being different things. */

.mmd-track[data-track="shots"] .mmd-seg { background:#2f6d8f; }
.mmd-track[data-track="moves"] .mmd-seg { background:#414958; }
.mmd-track[data-track="cues"]  .mmd-seg { background:#5d4a22; }
.mmd-track .mmd-seg.mmd-has-media { background:#0d1014; }

.mmd-seg .mmd-inline { position:absolute; inset:2px; z-index:6; resize:none;
  background:#0f1216; color:#f3f4f6; border:1px solid #6ea8c4; border-radius:3px;
  padding:4px 6px; font:inherit; outline:none; }

.mmd-marquee { position:absolute; z-index:7; pointer-events:none;
  border:1px solid #8ab4d8; background:rgba(138,180,216,.16); border-radius:2px; }

/* settings row ----------------------------------------------------------- */
.mmd-settings { display:flex; align-items:center; gap:12px; flex-wrap:wrap;
  flex:0 0 auto; padding:5px 8px; background:#181c23; border:1px solid #2c313c;
  border-radius:6px; }
.mmd-settings label { display:flex; align-items:center; gap:0; color:#9ca3af;
  font-size:11px; white-space:nowrap; flex:0 0 auto; min-width:max-content; }
.mmd-settings label > * { flex:0 0 auto; }
.mmd-settings input, .mmd-settings select { width:72px; flex:0 0 auto;
  background:#1c1f26;
  color:#e5e7eb; border:1px solid #2c313c; border-radius:4px; padding:2px 5px;
  font:inherit; }
.mmd-settings select { width:96px; }
.mmd-settings .mmd-derived { color:#e5e7eb; font-variant-numeric:tabular-nums;
  min-width:38px; text-align:right; }
.mmd-settings .mmd-unit, .mmd-settings .mmd-value { color:#e5e7eb; }
.mmd-settings .mmd-hint { color:#6b7280; font-size:11px; }
.mmd-settings .mmd-grow { flex:1; }

.mmd-settings .mmd-build { color:#4b5563; font-size:10px; font-variant-numeric:tabular-nums; }

/* A value the lattice had to correct flashes, so the correction is seen happening
   rather than discovered later as "my number did not save". */
@keyframes mmd-snap { 0% { background:#3d5a2a; border-color:#7fbf6a; }
                      100% { background:#1c1f26; border-color:#2c313c; } }
.mmd-settings input.mmd-snapped { animation:mmd-snap .9s ease-out; }

/* transport -------------------------------------------------------------- */
.mmd-transport { flex:0 0 auto; display:flex; align-items:center; gap:9px; }
.mmd-transport button { background:#2c313c; color:#e5e7eb; border:1px solid #3a4150;
  border-radius:5px; padding:3px 10px; cursor:pointer; font:inherit; }
.mmd-transport .mmd-clock { font-variant-numeric:tabular-nums; color:#e2564b;
  min-width:52px; }
.mmd-transport .mmd-range { color:#9ca3af; font-variant-numeric:tabular-nums; }
.mmd-transport .mmd-scrub { flex:1; accent-color:#e2564b; }

/* prompt boxes ----------------------------------------------------------- */
.mmd-prompt { flex:0 0 auto; display:flex; flex-direction:column; gap:3px;
  border:1px solid #2c313c; border-radius:6px; padding:6px 8px; background:#15181e; }
.mmd-prompt > label { font-size:9px; letter-spacing:.09em; color:#8b93a1; }
.mmd-prompt > label .mmd-hint { letter-spacing:0; color:#6b7280; }
.mmd-prompt textarea { min-height:44px; resize:vertical; background:transparent;
  color:#e5e7eb; border:0; outline:none; font:inherit; padding:0; }
.mmd-prompt textarea:disabled { color:#6b7280; }

/* One row per group, and each group a box of its own. Everything used to sit in a single
   wrapping row, which broke wherever the width ran out and put the end of a block's timing
   next to the start of its dialogue. */
.mmd-seg-fields { display:flex; flex-direction:column; gap:5px; align-items:stretch;
  margin-top:3px; }
.mmd-f-group { display:flex; gap:9px; flex-wrap:wrap; align-items:center;
  background:#191c23; border:1px solid #262b34; border-radius:6px; padding:5px 9px; }
.mmd-f-tag { flex:0 0 auto; min-width:58px; font-size:10px; letter-spacing:.08em;
  text-transform:uppercase; color:#6b7280; }
.mmd-seg-fields label { display:flex; align-items:center; gap:0; color:#9ca3af;
  font-size:11px; }
/* The subject description is a sentence, not a number, so it gets the room to be one. */
.mmd-seg-fields .mmd-f-wide { flex:1 1 320px; }
.mmd-seg-fields .mmd-f-wide input { width:100%; }
.mmd-seg-fields .mmd-f-retention { width:auto; }
/* The cast list carries a description, not a code, so it needs the room to show one. */
.mmd-seg-fields .mmd-f-ids { width:auto; max-width:240px; }
.mmd-seg-fields .mmd-f-ids-many { width:70px; }
/* The same weight the clip-settings row gives its units -- one look for one kind of
   thing, wherever it appears. */
.mmd-seg-fields .mmd-unit { color:#e5e7eb; }
.mmd-seg-fields .mmd-f-start, .mmd-seg-fields .mmd-f-end, .mmd-seg-fields .mmd-f-len { width:64px; }
.mmd-seg-fields input, .mmd-seg-fields select { width:88px; background:#1c1f26;
  color:#e5e7eb; border:1px solid #2c313c; border-radius:4px; padding:2px 4px;
  font:inherit; }
.mmd-seg-fields button { background:#3a2422; color:#f3d3cf; border:1px solid #5c332d;
  border-radius:4px; padding:2px 9px; cursor:pointer; font:inherit; }

/* the prompt node ---------------------------------------------------------- */
/* Read-only, but selectable and scrollable: a compiled prompt is something you copy out
   and diff. It scrolls inside its own node rather than growing one, so a long clip
   cannot push the box past the border and over the graph. */
.mmd-prompt-view { width:100%; height:100%; overflow:hidden; box-sizing:border-box;
  display:flex; flex-direction:column; gap:4px; padding:2px;
  font:12px/1.45 system-ui,sans-serif; }
.mmd-prompt-view > label { flex:0 0 auto; font-size:9px; letter-spacing:.09em;
  color:#8b93a1; }
.mmd-prompt-view > label .mmd-hint { letter-spacing:0; color:#6b7280; }
.mmd-prompt-text { flex:1 1 auto; margin:0; overflow:auto; white-space:pre-wrap;
  word-break:break-word; color:#cdd3dd; background:#15181e; border:1px solid #2c313c;
  border-radius:6px; padding:7px 9px; outline:none; font:inherit; user-select:text;
  cursor:text; }
.mmd-prompt-text:empty::before { content:"waiting for a timeline…"; color:#6b7280; }
.mmd-prompt-bad { color:#d98a8a; }
`;

export function install() {
  const id = "minimax-director-styles";
  if (document.getElementById(id)) return;
  const tag = document.createElement("style");
  tag.id = id;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
