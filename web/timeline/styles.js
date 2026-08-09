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
.mmd-prompt { transition:border-color .12s ease; }
.mmd-prompt:focus-within { border-color:#3f5a6b; }
.mmd-bar .mmd-grow { flex:1; }
.mmd-bar .mmd-len { color:#9ca3af; font-variant-numeric:tabular-nums; }

/* stage: fixed label column + scrolling track area ------------------------ */
/* The stage is exactly as tall as its tracks. Letting it absorb the leftover height
   left a field of empty grey under the last track, and made the prompt boxes fight the
   timeline for room instead of the node simply being the size it needs. */
.mmd-stage { flex:0 0 auto; display:flex;
  background:#15181e; border:1px solid #2c313c; border-radius:6px; overflow:hidden; }
.mmd-labels { flex:0 0 92px; padding-top:21px; border-right:1px solid #2c313c;
  background:#181c23; }
.mmd-label { height:62px; margin-bottom:6px; display:flex; align-items:center;
  justify-content:center; font-size:10px; letter-spacing:.09em; color:#8b93a1; }
.mmd-scroll { flex:1 1 auto; overflow-x:auto; overflow-y:hidden; position:relative;
  min-width:0; }
.mmd-canvas { position:relative; min-width:100%; padding-bottom:4px; }

.mmd-ruler { position:relative; height:17px; border-bottom:1px solid #262b34; }
.mmd-ruler span { position:absolute; top:0; font-size:9px; color:#6b7280;
  border-left:1px solid #333a45; padding-left:3px; height:100%;
  font-variant-numeric:tabular-nums; }

.mmd-track { position:relative; height:62px; margin-bottom:6px; margin-top:4px;
  background:#1c1f26; border-top:1px solid #22262e; border-bottom:1px solid #22262e; }

.mmd-end { position:absolute; top:0; bottom:0; width:1px; z-index:4;
  border-left:1px dashed #4b5563; pointer-events:none; }

.mmd-playhead { position:absolute; top:0; bottom:0; width:2px; background:#e2564b;
  pointer-events:none; z-index:5; }
.mmd-playhead::before { content:""; position:absolute; top:0; left:-4px;
  border:5px solid transparent; border-top-color:#e2564b; }

/* segments --------------------------------------------------------------- */
/* The outline is an inset shadow, not a border, on purpose. A border creates a padding
   box one pixel inside the element, so a grip pinned to right:0 lands on that inner edge
   -- leaving a hairline of the block that answers to the parent's grab cursor instead of
   the grip's resize cursor. A shadow paints the same line without moving anything. */
.mmd-seg { position:absolute; top:3px; bottom:3px; border-radius:4px; cursor:grab;
  overflow:hidden; box-sizing:border-box; user-select:none;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.35); }
.mmd-seg { transition:filter .12s ease; }
.mmd-seg:hover { filter:brightness(1.18); }
.mmd-seg:active { cursor:grabbing; }
.mmd-seg.mmd-sel { outline:2px solid #e5e7eb; outline-offset:-2px; z-index:3; }
/* The resize handles stay invisible until the pointer is on the segment, then show
   where the edges are rather than making the user hunt for them. */
.mmd-seg .mmd-grip { background:transparent; transition:background .12s ease; }
.mmd-seg:hover .mmd-grip { background:rgba(255,255,255,.22); }
.mmd-seg .mmd-grip:hover { background:#6ea8c4; }

/* Touching blocks put two handles side by side. Outlining the whole block whose edge is
   under the pointer says which one a drag would resize -- the handles alone are 7px of
   near-identical highlight and give no answer. */
.mmd-seg:has(.mmd-grip:hover), .mmd-seg.mmd-resizing {
  outline:2px solid #6ea8c4; outline-offset:-2px; z-index:4; }
.mmd-seg.mmd-resizing .mmd-grip.mmd-l, .mmd-seg.mmd-resizing .mmd-grip.mmd-r {
  background:#6ea8c4; }
.mmd-seg .mmd-cap { position:absolute; left:6px; right:6px; top:5px; font-size:11px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  text-shadow:0 1px 2px rgba(0,0,0,.85); pointer-events:none; }
.mmd-seg .mmd-chip { position:absolute; left:0; bottom:0; padding:1px 5px; font-size:9px;
  background:rgba(0,0,0,.62); color:#d7dbe2; border-top-right-radius:4px;
  max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  pointer-events:none; }
.mmd-seg .mmd-grip { position:absolute; top:0; bottom:0; width:7px; cursor:ew-resize; }
.mmd-seg .mmd-grip.mmd-l { left:0; } .mmd-seg .mmd-grip.mmd-r { right:0; }
.mmd-seg .mmd-media { position:absolute; inset:0; width:100%; height:100%;
  object-fit:cover; pointer-events:none; }
.mmd-seg.mmd-has-media .mmd-cap { top:auto; bottom:16px; }

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
.mmd-settings label { display:flex; align-items:center; gap:5px; color:#9ca3af;
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

.mmd-seg-fields { display:flex; gap:9px; flex-wrap:wrap; align-items:center;
  margin-top:3px; }
.mmd-seg-fields label { display:flex; align-items:center; gap:4px; color:#9ca3af;
  font-size:11px; }
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
