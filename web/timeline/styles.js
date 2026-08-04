/**
 * Styles for the timeline editor, injected once.
 *
 * A DOM widget renders outside ComfyUI's canvas, so it needs its own styling. Colours
 * are hard-wired rather than inherited: ComfyUI themes vary, and a timeline whose track
 * colours drift with the theme stops being readable at a glance.
 */

const CSS = `
.mmd { display:flex; flex-direction:column; gap:6px; width:100%; height:100%;
  font:12px/1.4 system-ui,sans-serif; color:#e5e7eb; box-sizing:border-box; }

.mmd-bar { display:flex; align-items:center; gap:6px; flex:0 0 auto; }
.mmd-bar button { background:#2c313c; color:#e5e7eb; border:1px solid #3a4150;
  border-radius:4px; padding:3px 9px; cursor:pointer; font:inherit; }
.mmd-bar button:hover { background:#39404e; }
.mmd-bar .mmd-grow { flex:1; }
.mmd-bar .mmd-len { color:#9ca3af; font-variant-numeric:tabular-nums; }

.mmd-stage { flex:1 1 auto; min-height:120px; overflow:auto;
  background:#15181e; border:1px solid #2c313c; border-radius:5px; padding:6px; }

.mmd-ruler { position:relative; height:15px; margin-bottom:4px; }
.mmd-ruler span { position:absolute; top:0; font-size:10px; color:#6b7280;
  transform:translateX(2px); border-left:1px solid #3a4150; padding-left:3px; height:100%; }

.mmd-track { position:relative; height:38px; margin-bottom:5px;
  background:#1c1f26; border:1px solid #2c313c; border-radius:4px; }
.mmd-track::after { content:attr(data-label); position:absolute; left:5px; top:2px;
  font-size:9px; letter-spacing:.06em; text-transform:uppercase; color:#4b5563;
  pointer-events:none; }

.mmd-seg { position:absolute; top:3px; bottom:3px; border-radius:3px; cursor:grab;
  overflow:hidden; padding:3px 7px; box-sizing:border-box; font-size:11px;
  white-space:nowrap; text-overflow:ellipsis; user-select:none; }
.mmd-seg.sel { outline:2px solid #cbd5e1; outline-offset:-1px; }
.mmd-seg .grip { position:absolute; top:0; bottom:0; width:6px; cursor:ew-resize; }
.mmd-seg .grip.l { left:0; } .mmd-seg .grip.r { right:0; }

.mmd-track[data-track="shots"] .mmd-seg { background:#2f6d8f; }
.mmd-track[data-track="moves"] .mmd-seg { background:#4b5563; }
.mmd-track[data-track="cues"]  .mmd-seg { background:#7a5b2e; }

.mmd-edit { flex:0 0 auto; display:grid; gap:5px;
  grid-template-columns:repeat(4,minmax(0,1fr)); align-items:center; }
.mmd-edit textarea { grid-column:1/-1; min-height:46px; resize:vertical;
  background:#15181e; color:#e5e7eb; border:1px solid #2c313c; border-radius:4px;
  padding:5px; font:inherit; }
.mmd-edit label { display:flex; align-items:center; gap:4px; color:#9ca3af; font-size:11px; }
.mmd-edit input, .mmd-edit select { width:100%; background:#15181e; color:#e5e7eb;
  border:1px solid #2c313c; border-radius:4px; padding:3px; font:inherit; }
.mmd-edit .danger { background:#4a2320; border-color:#6b3029; color:#f3d3cf;
  cursor:pointer; border-radius:4px; padding:4px; }
.mmd-hint { color:#6b7280; font-size:11px; }
`;

export function install() {
  const id = "minimax-director-styles";
  if (document.getElementById(id)) return;
  const tag = document.createElement("style");
  tag.id = id;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
