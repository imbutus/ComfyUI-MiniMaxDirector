/**
 * The MiniMaxDirector timeline widget.
 *
 * Mounts the editor as a DOM widget on the `MiniMaxDirector` node and hides the raw
 * JSON string widget behind it. The JSON stays the only stored state -- the editor
 * reads it on render and writes it back on every edit -- so a graph saved with this
 * extension installed still loads, and still runs, without it.
 */

import { app } from "../../scripts/app.js";
import { parse, serialize } from "./timeline/model.js";
import { TimelineEditor } from "./timeline/editor.js";
import { CastEditor, EMPTY as EMPTY_CAST, parseCast } from "./timeline/cast.js";
import { install } from "./timeline/styles.js";
import { BUILD, VERSION } from "./build.js";

const NODE = "MiniMaxDirector";
const PROMPT_NODE = "MiniMaxDirectorPrompt";
const REPORT_NODE = "MiniMaxDirectorReport";
const STATE_WIDGET = "timeline";
const CAST_WIDGET = "cast";
const PROMPT_VIEW = "compiled_prompt";
/** Wide enough to read a compiled shot without wrapping every few words. */
const PROMPT_SIZE = [520, 420];

/**
 * What was selected on each director, keyed by node id.
 *
 * ComfyUI's own undo does not edit a node, it rebuilds it: `Cmd+Z` after any change
 * destroys the node and constructs a new one from the restored graph, and with it a new
 * editor whose selection starts empty. Undoing a change *to* a block would leave you
 * looking at the block with nothing selected, having to find and click it again -- which
 * is the moment an undo stops feeling like an undo.
 *
 * Keeping it here rather than in the editor is the whole point: this survives the
 * instance. Node ids are preserved across that rebuild, which is what makes them a usable
 * key. A stale entry costs nothing -- the panel drops any index whose block is gone.
 */
const SELECTION = new Map();

/**
 * Editors pulled up over their node's socket band, and where they should sit.
 *
 * The frontend places a DOM widget at `node.pos.y + margin + widget.y` and recomputes
 * `widget.y` on every frame from the widget layout -- which starts below the last socket.
 * Writing `y` from a node callback is undone by the same frame's layout pass, so the
 * value is written here instead, on the canvas callback that runs immediately before the
 * frontend reads it.
 */
const PULLED = new Map();
const TOP_INSET = 6;

/** Text metrics for the canvas font, kept between frames: this runs on every draw. */
const RULER = document.createElement("canvas").getContext("2d");
const INSETS = new Map();

/**
 * How far the socket labels reach in from each edge of the node, in node pixels.
 *
 * The editor's first two rows are drawn over the band the sockets live in, so they have
 * to keep clear of the labels the canvas paints there. That used to be a fixed 176px on
 * both sides -- room for a name far longer than any this node has -- and the toolbar,
 * three hundred pixels poorer than the node it sits on, wrapped its last button onto a
 * second line with empty band on either side of it.
 *
 * So it is measured: the widest input name and the widest output name, in the font the
 * canvas draws them in, plus the slot dot and a gap. Cached per node by the names
 * themselves, because the answer only changes when the sockets do.
 */
function socketInset(node) {
  // Only the slots the canvas actually draws in the socket column. `node.inputs` also
  // holds one entry per widget -- `ref_image_size`, `timeline`, `cast` -- which are drawn
  // on their own widget rows, not up here. Measured with them the answer came out at
  // very nearly the old fixed number, which is why the toolbar did not move.
  const names = (slots) => (slots || [])
    .filter((slot) => slot && !slot.widget && !slot.hidden)
    .map((slot) => String(slot.label || slot.localized_name || slot.name || ""));
  const inputs = names(node?.inputs);
  const outputs = names(node?.outputs);
  const key = `${inputs.join("|")}//${outputs.join("|")}`;
  const held = INSETS.get(node?.id);
  if (held?.key === key) return held.inset;

  const graph = globalThis.LiteGraph;
  RULER.font = `${graph?.NODE_TEXT_SIZE ?? 14}px ${graph?.NODE_FONT ?? "Inter"}, sans-serif`;
  // The dot and the gap between it and the name, then a gap after the name. The label
  // starts one slot-height in from the edge, which is where the canvas draws the dot.
  const column = (list) => Math.round(SLOT_INSET
    + list.reduce((wide, name) => Math.max(wide, RULER.measureText(name).width), 0)
    + SLOT_GAP);
  const inset = { left: column(inputs), right: column(outputs) };
  INSETS.set(node?.id, { key, inset });
  return inset;
}

/** Where a slot's name starts, and the air left after it. Both in node pixels: the dot is
 *  drawn a slot-height in from the edge, and a label that ends flush against a button
 *  reads as part of it. */
const SLOT_INSET = 22;
const SLOT_GAP = 14;

/** The floor the card list is allowed to shrink to. Matches `min-height` in the
 *  stylesheet, which is what the box would clamp to anyway. */
const CAST_BOX_MIN = 120;

/**
 * Give the open card list a height, and remember it on the node.
 *
 * The list is the one part of this editor with a height of its own: everything else is as
 * tall as its content and nothing else. That height is stored in the node's properties, so
 * it comes back with the workflow rather than being re-derived from whatever the layout
 * happened to be doing when the graph loaded -- which is what made this unpredictable.
 */
function setListHeight(node, editor, height) {
  const box = editor.panels
    ?.find((item) => item.dataset.panel === "cast")
    ?.querySelector(".mmd-cast-box");
  if (!box) return;
  const to = Math.max(CAST_BOX_MIN, Math.round(height));
  node.properties = node.properties || {};
  node.properties.castHeight = to;
  box.style.height = `${to}px`;
}

/** How tall a pulled-up editor wants to be: its content, plus the inset it starts at. */
function contentHeightOf(state, widget) {
  const root = state.editor.root;
  // Measured at its natural height for one layout pass. The stage stretches to whatever
  // room it is given, so asking the element how tall it is only reports back the height
  // it already has -- and summing the children misses the margin that holds the stage
  // clear of the sockets, which is exactly the number this is for.
  const held = root.style.height;
  // The measurement perturbs the very layout `growWithPrompts` is watching, and its
  // observer answered by adding the difference to the node -- every frame, for as long as
  // this ran. Measuring is not a resize, and it says so.
  state.editor.measuring = true;
  root.style.height = "auto";
  const content = root.scrollHeight;
  root.style.height = held;
  requestAnimationFrame(() => { state.editor.measuring = false; });
  return TOP_INSET + content + (widget.margin ?? 0) * 2;
}

function fitPulled(state, widget) {
  // Exactly its content, up or down. There is nothing left for a shrink to discard: the
  // one height anybody asks for by hand belongs to the card list, it is stored on the
  // node, and it is part of that content. Everything that used to argue over this number
  // -- a list that absorbed the node's spare room, a remembered panel height, a rule that
  // the node may grow but never shrink -- was three answers to a question with one.
  const target = contentHeightOf(state, widget);
  if (Math.abs(state.node.size[1] - target) >= 2) {
    state.node.setSize([state.node.size[0], Math.max(MIN_HEIGHT, Math.round(target))]);
  }
  state.node.graph?.setDirtyCanvas(true, true);
}

function pullUp(node, widget, editor) {
  // Three passes: each resize changes the element's height on the following draw, so the
  // content measured after it is the one that settles the node.
  PULLED.set(widget, { node, editor, band: 0, left: 3 });
  const canvas = app.canvas;
  if (!canvas || canvas.mmdPulling) return;
  canvas.mmdPulling = true;

  const drawn = canvas.onDrawForeground;
  canvas.onDrawForeground = function (...args) {
    for (const [held, state] of PULLED) {
      // Out of the document is not the same as gone: collapsing a Nodes 2.0 node takes the
      // editor's whole row out and puts a new one back on expand, and an entry dropped
      // here is the state `pullUpUnderVue` needs to pull that new row up again. Skipped
      // while it is away, deleted only once the node has left the graph.
      if (!held.element?.isConnected) {
        if (state.node.graph == null) PULLED.delete(held);
        continue;
      }
      // The first frame's own value *is* the band: whatever the layout reserved for the
      // sockets is exactly what the editor now has to stay clear of.
      const learned = held.y > TOP_INSET;
      if (learned) state.band = held.y;
      held.y = TOP_INSET;
      state.editor.setBand(state.band - TOP_INSET, socketInset(state.node));

      // Height as well as position. The layout still reserves the band, so the element's
      // own height is computed as if it began below the sockets -- moved up and left at
      // that height it would stop short, leaving the band's worth of empty node under it.
      // The frontend takes the margin off this itself (`computedHeight - margin * 2`),
      // so taking it off here as well left the element two margins short of the node.
      held.computedHeight = Math.max(MIN_HEIGHT, state.node.size[1] - TOP_INSET);

      // And the node itself only needed that height because the editor started low.
      // Sized from the content rather than by subtracting the band: the element's own
      // height is still the old one for the frames right after a resize, which is how the
      // globals ended up clipped.
      if (learned && state.left > 0) {
        state.left -= 1;
        requestAnimationFrame(() => fitPulled(state, held));
      }
    }
    return drawn?.apply(this, args);
  };
}

/* The floor the editor is allowed to shrink to. Low on purpose: it used to be the height
   of a full timeline view, which the DOM widget reports to litegraph as its minimum -- so
   the node could never shrink to a short panel like the cast, whatever it was told. */
const MIN_HEIGHT = 150;
/** Matches LTXDirector, whose editor sets `size[0] = 1375` and saves at 1380x1000.
 *  A director is a workspace, not a form -- at form size the tracks are unreadable. */
const DEFAULT_SIZE = [1380, 1000];

console.info(`[MiniMaxDirector] build ${BUILD}`);

app.registerExtension({
  name: "imbutus.MiniMaxDirector",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    const mounts = {
      [NODE]: attach,
      [PROMPT_NODE]: (node) => attachPromptView(node, "prompt"),
      // Same widget, a different field of the same preview: the compile and the lint run
      // together, so a report panel costs one more line rather than a second request.
      [REPORT_NODE]: (node) => attachPromptView(node, "report"),
    };
    const mount = mounts[nodeData.name];
    if (!mount) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      mount(this);
    };
  },
});

function attach(node) {
  const json = node.widgets?.find((widget) => widget.name === STATE_WIDGET);
  if (!json) return;

  // The JSON is still the stored value; it just stops taking up room on the node.
  // -4 cancels the padding ComfyUI adds around every widget.
  json.hidden = true;
  json.computeSize = () => [0, -4];
  hideElement(json);

  // The clip settings are short numbers, and ComfyUI gives every widget the node's full
  // width. At 1380px that is four near-empty bars, so they are hidden here and drawn
  // compactly inside the editor -- still the same widget objects, so the graph
  // serialises exactly as before.
  const settings = {};
  for (const name of ["width", "height", "ref_image_size"]) {
    const widget = node.widgets?.find((w) => w.name === name);
    if (!widget) continue;
    settings[name] = widget;
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
  }

  const editor = new TimelineEditor(
    () => parse(json.value),
    (timeline) => { json.value = serialize(timeline); },
    settings,
  );

  // The cast is a tab on this node, stored in its own `cast` widget -- and a wired Cast
  // node, if there is one, overrides it exactly as ComfyUI overrides any widget with a
  // link. The chips and the compiled preview read whichever is in force.
  const cast = node.widgets?.find((widget) => widget.name === CAST_WIDGET);
  if (cast) {
    cast.hidden = true;
    cast.computeSize = () => [0, -4];
    hideElement(cast);
    if (!cast.value?.trim()) cast.value = JSON.stringify(EMPTY_CAST, null, 2);
  }

  editor.castJSON = () => cast?.value || "";
  editor.castOf = () => {
    const text = editor.castJSON();
    return text ? parseCast(text) : null;
  };

  if (cast) {
    const inside = new CastEditor(
      () => parseCast(cast.value),
      (state) => { cast.value = JSON.stringify(state, null, 2); },
      () => parse(json.value),
    );
    // A card saved before this stored no `keep them` at all: the panel drew the first
    // marker, and the compiler read the blank as "retain this person the way their file
    // is retained" -- so a card reading `fully_preserved` beside a `weak_reference` photo
    // compiled as `weak_reference`. Normalising makes the two agree without waiting for
    // an edit that may never come. It runs after `onConfigure` as well as here, because
    // a graph load writes the saved widget value over anything set at construction.
    const normaliseCast = () => {
      const normalised = JSON.stringify(parseCast(cast.value), null, 2);
      if (cast.value === normalised) return;
      cast.value = normalised;
      inside.render();
    };
    normaliseCast();
    const configuredCast = node.onConfigure;
    node.onConfigure = function () {
      const result = configuredCast?.apply(this, arguments);
      normaliseCast();
      return result;
    };

    // Editing the cast changes the compiled prompt and the block's chips, and neither
    // knows the tab exists.
    inside.onChange = () => {
      editor.schedulePreview();
      editor.paintPicker(editor.read());
      // The blocks carry the cast now -- a transfer chip names the card and who receives
      // it -- so a cast edit has to reach the timeline, not just the prompt.
      editor.render();
      editor.paintTabCount(parseCast(cast.value).cards.length);
      fitPulled(PULLED.get(widget) ?? { node, editor }, widget);
    };
    inside.onResize = () => fitPulled(PULLED.get(widget) ?? { node, editor }, widget);
    editor.castPanel?.appendChild(inside.root);
    // Switching tabs changes how tall the node has to be, and nothing else measures it.
    editor.onTab = (name) => {
      // Which tab is open is part of the node, not of the session: it rides along in the
      // node's properties so a reload comes back to the panel you were working in.
      node.properties.tab = name;
      inside.render();
      // Each tab keeps its own height, and the one this tab owns is the card list's. It is
      // put back on the way in rather than trusted to survive: the panel is display:none
      // while another tab is open, and everything measured in that state reads zero.
      const stored = Number(node.properties?.castHeight) || 0;
      if (name === "cast" && stored) setListHeight(node, editor, stored);
      const state = PULLED.get(widget) ?? { node, editor };
      requestAnimationFrame(() => {
        fitPulled(state, widget);
        requestAnimationFrame(() => fitPulled(state, widget));
      });
    };
    // The FILE row on a block can make a card already pointed at that block's file: one
    // photograph often holds several subjects, and picking the same filename out of a
    // select once per person is the long way to say so.
    editor.onAddCard = (filename) => inside.addSubject(filename || "");
    // Clear empties the piece, and the cards are part of the piece -- they just live in a
    // widget of their own, which the timeline editor has no hand on.
    editor.onClearCast = () => inside.clear();
    // A piece loaded on IMPORT / EXPORT brings its cards with it, and they land the same
    // way: through the cast editor's own commit, so the tab, the chips and the compiled
    // preview all hear about it exactly as they do for a card typed by hand. Parsed on the
    // way in, because a document written by an older build is normalised there.
    editor.onImportCast = (loaded) => inside.commit(parseCast(JSON.stringify(loaded)));
    // A card names its files by name, so it is the other half of the document that can
    // point at a file that is gone -- and it is drawn by an editor that never asks the
    // server anything. One answer, borrowed from the half that does the asking.
    inside.absentOf = () => editor.absent;
    editor.onAbsent = () => inside.render();
    // `edit` beside a subject on the FILE row lands on that card's name box. A frame
    // later, because the tab it lives on was hidden until the click that got here.
    editor.onEditCard = (at) => requestAnimationFrame(() => {
      const box = inside.list.querySelector(`[data-card="${at}"] .mmd-card-name`);
      box?.focus();
      box?.scrollIntoView({ block: "nearest" });
    });

    // The grip is the other hand allowed to set a list height; the host is what remembers
    // it, because the height belongs to the node and travels with the workflow.
    inside.onBoxHeight = (height) => {
      setListHeight(node, editor, height);
      // The node follows the list, as it does for everything else that changes height.
      fitPulled(PULLED.get(widget) ?? { node, editor }, widget);
    };

    node.castEditor = inside;
    requestAnimationFrame(() => {
      inside.render();
      editor.paintTabCount(parseCast(cast.value).cards.length);
      // A height asked for in an earlier session, put back before anything measures. With
      // none, the list is simply as tall as its cards.
      const stored = Number(node.properties?.castHeight) || 0;
      if (stored) setListHeight(node, editor, stored);
    });
  }

  // Reachable from the node for tests and for poking at a live graph in the console.
  // The editor holds no state of its own, so nothing here can drift from the document.
  node.timelineEditor = editor;

  remember(node, editor);

  // Every compile goes to the prompt nodes wired downstream. The editor no longer shows
  // the string itself: it was the tallest thing on the node, and it arrived late enough
  // to miss the sizing pass and hang out through the bottom.
  editor.onPreview = (result) => paintPromptViews(node, result);

  const widget = node.addDOMWidget(STATE_WIDGET + "_editor", "minimax_director", editor.root, {
    getMinHeight: () => MIN_HEIGHT,
    hideOnZoom: false,
    // The editor owns no state, so there is nothing here to serialise.
    serialize: false,
    getValue: () => undefined,
    setValue: () => {},
  });
  widget.serializeValue = () => undefined;
  refuseWidthStamp(widget);

  // Up into the socket band: ten input labels reserved 200px of node that nothing was
  // ever drawn in.
  pullUp(node, widget, editor);

  // And the same job again for the renderer that ignores `hidden`.
  watchRows(widget);

  // Open at workspace size. A saved graph overwrites this afterwards, so a node the
  // user has resized keeps its own dimensions.
  node.setSize([
    Math.max(node.size?.[0] ?? 0, DEFAULT_SIZE[0]),
    Math.max(node.size?.[1] ?? 0, DEFAULT_SIZE[1]),
  ]);

  // Dragging the node's own corner asks for room, and every panel but the card list is as
  // tall as its content -- so on WHO & WHAT the gesture means "show me more cards" and the
  // difference goes to the list, where it is stored and stays. Anywhere else there is
  // nothing to stretch, and the next fit puts the node back on its content.
  const resized = node.onResize;
  node.onResize = function () {
    const result = resized?.apply(this, arguments);
    const state = PULLED.get(widget) ?? { node, editor };

    // The height is the content's, on every tab, and the answer is given in this frame
    // rather than the next one. Answering late is what made the drag blink: litegraph had
    // already drawn the node at the height the pointer asked for, and the correction
    // arrived after that frame was on screen -- once per pointer move, for the whole drag.
    // Refused inside the gesture there is nothing to see; the width still follows the
    // pointer, which is the dimension a timeline is dragged for.
    //
    // The card list used to take the difference on its own tab, which made one gesture
    // mean two things depending on which panel was open -- and the tab where it meant
    // something was the tab that still moved while every other one stood still. The grip
    // in the list's own corner is how it is given a height, and it is the only way.
    //
    // `size[1]` directly, never `setSize`: that calls this handler, and a handler that
    // resizes its own node is a handler that calls itself.
    node.size[1] = Math.max(MIN_HEIGHT, Math.round(contentHeightOf(state, widget)));
    return result;
  };

  stampTitle(node);
  growWithPrompts(node, editor, widget);
  fitAfterLoad(node, editor, widget);

  // The first render needs a laid-out element to measure, so wait one frame.
  requestAnimationFrame(() => {
    editor.render();
    // Whether every file this piece names is actually on this machine, asked once on the
    // way in. A workflow that arrived from somewhere else is the common case for a missing
    // file, and it has no import to notice one -- the count lands on the IMPORT / EXPORT
    // tab, which is visible from whichever panel is open.
    editor.checkMedia();
    // Twice: the first pass resizes the node, and the widget's own height only follows
    // on the frame after that, so the second pass settles the remainder.
    fitPulled(PULLED.get(widget) ?? { node, editor }, widget);
    requestAnimationFrame(() => {
      fitPulled(PULLED.get(widget) ?? { node, editor }, widget);
      // Last, and only now: switching tabs measures the timeline on the way out, so the
      // panel inherits its height instead of opening at whatever it happens to need.
      const tab = node.properties?.tab;
      if (tab && tab !== "timeline") editor.showTab(tab);
    });
  });
}

/**
 * Carry the selection across a rebuild of the node, and across a reload of the page.
 *
 * The editor reports its state after every panel render; the last report for this node id
 * is handed back to whatever editor is mounted next. The view state travels with it --
 * the playhead and the zoom are equally annoying to lose, and for the same reason.
 *
 * The map is memory, so it is empty on a page that has just loaded, and the block being
 * worked on came back deselected -- the panel that was full of that block's fields was
 * suddenly "no segment selected". Which block that was is written into the node's
 * properties as well, where the tab already lives, because those are what a workflow
 * carries. Only the one block: a marquee is a gesture, not a place you were.
 */
function remember(node, editor) {
  // A frame late, and deliberately: `onNodeCreated` runs during construction, before the
  // graph has given the node its id. Reading it now would look up -1 and find nothing.
  // This callback is registered before the one that renders, so it still lands first.
  requestAnimationFrame(() => {
    const saved = SELECTION.get(node.id);
    if (saved) {
      editor.selection = saved.selection;
      editor.selected = saved.selected;
      editor.playhead = saved.playhead;
      editor.zoom = saved.zoom;
      return;
    }
    // Nothing in memory: the page is new, and the workflow is the only record. An index
    // naming a block that is no longer there is dropped by the panel on the first render,
    // so nothing here has to check the document.
    const stored = node.properties?.selection;
    if (stored && Number.isInteger(stored.index)) {
      editor.selection = { track: stored.track, index: stored.index };
    }
  });

  editor.onState = (source) => {
    SELECTION.set(node.id, {
      selection: source.selection,
      selected: [...source.selected],
      playhead: source.playhead,
      zoom: source.zoom,
    });
    node.properties = node.properties || {};
    node.properties.selection = source.selection
      ? { track: source.selection.track, index: source.selection.index }
      : null;
  };
}

/**
 * Give a `MiniMaxDirectorPrompt` node a box to show the compiled prompt in.
 *
 * The widget is ours rather than the one ComfyUI builds for a text preview, because this
 * node has to show a string that no run produced. `install()` is called here as well as
 * by the editor: a graph can hold this node with no director on the canvas yet, and the
 * stylesheet goes in once either way.
 */
function attachPromptView(node, field = "prompt") {
  install();

  const heading = field === "report"
    ? '<label>LINT REPORT <span class="mmd-hint">what to check before you run</span></label>'
    : '<label>COMPILED PROMPT <span class="mmd-hint">what the model actually receives</span></label>';

  const root = document.createElement("div");
  root.className = "mmd-prompt-view";
  // A copy button, because this text is read somewhere else -- pasted into a chat, filed
  // with a render, sent to somebody. Selecting a panel this long by hand across a zoomed
  // canvas is a drag that ends wherever the pointer left the node.
  root.innerHTML = `<div class="mmd-prompt-head">${heading}`
    + `<button type="button" class="mmd-prompt-copy" title="Copy this text to the clipboard">copy</button>`
    + `</div><pre class="mmd-prompt-text" tabindex="0"></pre>`;

  const copy = root.querySelector(".mmd-prompt-copy");
  copy.addEventListener("pointerdown", (event) => event.stopPropagation());
  copy.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = root.querySelector(".mmd-prompt-text")?.textContent ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // A page served over plain http has no clipboard API at all -- which is every pod
      // reached by ip:port. The old way still works there and is silent when it does.
      const box = document.createElement("textarea");
      box.value = text;
      box.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(box);
      box.select();
      try { document.execCommand("copy"); } catch { /* nothing else to try */ }
      box.remove();
    }
    // The button says what happened: a copy that looks like nothing is a copy you press
    // twice, and there is no other signal that the clipboard changed.
    copy.textContent = "copied";
    clearTimeout(copy.timer);
    copy.timer = setTimeout(() => { copy.textContent = "copy"; }, 1200);
  });

  const view = node.addDOMWidget(PROMPT_VIEW, "minimax_director_prompt", root, {
    getMinHeight: () => 120,
    hideOnZoom: false,
    serialize: false,
    getValue: () => undefined,
    setValue: () => {},
  });
  view.serializeValue = () => undefined;
  refuseWidthStamp(view);

  node.promptView = root.querySelector(".mmd-prompt-text");
  node.promptField = field;
  node.setSize([
    Math.max(node.size?.[0] ?? 0, PROMPT_SIZE[0]),
    Math.max(node.size?.[1] ?? 0, PROMPT_SIZE[1]),
  ]);

  // A run fills it the ordinary way, so the node still works with the timeline editor
  // never having compiled anything -- a graph opened and queued without touching it.
  const executed = node.onExecuted;
  node.onExecuted = function (message) {
    executed?.apply(this, arguments);
    const text = message?.text;
    if (text?.length) paintPromptView(node, { ok: true, [field]: text.join("") });
  };

  // Wiring it up mid-session should show the prompt at once rather than on the next
  // keystroke, so ask whichever director now feeds it for what it last compiled.
  const connections = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    const result = connections?.apply(this, arguments);
    for (const director of (this.graph ?? app.canvas?.graph)?._nodes ?? []) {
      if (director.type !== NODE || !director.timelineEditor) continue;
      if (!promptViewsOf(director).includes(node)) continue;
      if (director.timelineEditor.preview) {
        paintPromptView(node, director.timelineEditor.preview);
      }
    }
    return result;
  };
}

/** The prompt nodes wired to `director`, in graph order. */
function promptViewsOf(director) {
  // Never `app.graph`: reading it before the app has started logs "ComfyApp graph accessed
  // before initialization", and this runs while a workflow is still loading.
  const graph = director.graph ?? app.canvas?.graph;
  const found = [];
  for (const output of director.outputs ?? []) {
    for (const id of output.links ?? []) {
      const target = graph?.getNodeById?.(graph?.links?.[id]?.target_id);
      if (target?.promptView && !found.includes(target)) found.push(target);
    }
  }
  return found;
}

function paintPromptViews(director, result) {
  for (const node of promptViewsOf(director)) paintPromptView(node, result);
}

function paintPromptView(node, result) {
  if (!node.promptView) return;
  node.promptView.classList.toggle("mmd-prompt-bad", !result.ok);
  // An empty report is an answer, not a blank panel: nothing found is the thing you
  // wanted to know, and a box with nothing in it reads as a box that is not working.
  const found = result[node.promptField ?? "prompt"] ?? "";
  node.promptView.textContent = result.ok
    ? (found || (node.promptField === "report" ? "nothing to report" : ""))
    : `could not compile: ${result.error}`;
  node.graph?.setDirtyCanvas(true, true);
}

/**
 * A saved graph restores its own node size, which lands *after* the editor mounted and
 * measured itself. A graph saved before the editor grew a field therefore reopens too
 * short, with the last prompt box hanging through the bottom of the node.
 *
 * Growing only: a node someone deliberately made taller keeps its height, and one that
 * is too short for its own content stops being too short.
 */
function fitAfterLoad(node, editor, widget) {
  const configured = node.onConfigure;
  node.onConfigure = function (info) {
    const result = configured?.apply(this, arguments);
    const state = () => PULLED.get(widget) ?? { node, editor };
    requestAnimationFrame(() => {
      fitPulled(state(), widget);
      requestAnimationFrame(() => {
        fitPulled(state(), widget);
        centreOnNode(node);
      });
    });
    return result;
  };
}

/**
 * Put the director in the middle of the canvas.
 *
 * A workflow stores one viewport -- a scale and an offset in graph units -- and that offset
 * only frames the node on the window it was saved from. On a shorter screen the timeline
 * opens half off the edge. The zoom travels fine; where to look does not, because it is the
 * one part that depends on how big the window is, so it is computed here instead of stored.
 *
 * Only on load. Panning afterwards is the author's business.
 */
/** Where the director's top-left corner should sit on screen, in pixels. Measured from the
 *  view a first-time reader should get: the title clear of the tab strip and the toolbar,
 *  the sidebar beside it rather than under it, and the whole panel on screen. */
const MARGIN = [139, 154];
/** The zoom a workflow opens at: the whole director readable without scrolling to it. */
const OPENING_ZOOM = 0.91;

/** Node ids already framed in this page session. See `centreOnNode`. */
const FRAMED = new Set();

function centreOnNode(node) {
  const canvas = app.canvas;
  const view = canvas?.ds;
  const element = canvas?.canvas;
  if (!view?.offset || !element?.clientWidth) return;

  // Once per node per page session, and again any time the corner is off-screen.
  //
  // `onConfigure` fires for every rebuild, and ComfyUI's undo *is* a rebuild -- so framing
  // on all of them yanked the canvas about on every Cmd+Z, throwing away wherever the
  // author had panned to. Framing only when the corner is hidden was the first attempt,
  // and it was too shy: a workflow whose stored offset happens to leave the corner on
  // screen never got framed at all, and that offset was written on somebody else's window.
  // The first configure after load is the one that means "this workflow just opened"; the
  // rest are rebuilds and leave the canvas alone.
  const first = !FRAMED.has(node.id);
  FRAMED.add(node.id);

  const corner = [
    (node.pos[0] + view.offset[0]) * view.scale,
    (node.pos[1] + view.offset[1]) * view.scale,
  ];
  const showing = corner[0] > 0 && corner[0] < element.clientWidth
    && corner[1] > 0 && corner[1] < element.clientHeight;
  if (showing && !first) return;

  // The zoom is set too, not only the position. A workflow stores the scale it was saved
  // at, which is somebody else's window; opening at a known one means the node is the same
  // size every time it is opened, which is what a screenshot or a recording needs.
  if (first) view.scale = OPENING_ZOOM;

  // The corner rather than the middle. Centring is right for a node that fits on screen;
  // this one is a workspace taller than most windows, so centring it put the toolbar and
  // the clip settings above the top edge -- the two things you reach for first.
  view.offset[0] = MARGIN[0] / view.scale - node.pos[0];
  view.offset[1] = MARGIN[1] / view.scale - node.pos[1];
  canvas.setDirty(true, true);
}

/**
 * A part of the editor that gets taller makes the node taller.
 *
 * The widget gets a fixed slice of the node, so a box that grows inside it takes that
 * height from the timeline -- you pull a prompt box down and the tracks shrink to pay for
 * it. Passing the change on to the node keeps everything else the size it was.
 *
 * Every direct child is watched, not just the textareas. A textarea is only the case that
 * came up first; anything that changes height after the node was measured has the same
 * effect, and the one that did not grow the node hung out through the bottom of it and
 * drew over the graph below.
 *
 * `offsetHeight` rather than a bounding rect: the widget sits inside a CSS transform, so
 * a rect is in screen pixels while the node's size is in graph units.
 */
/**
 * The pack's version, written along the node's own title bar.
 *
 * Drawn rather than written into `node.title`: a title is saved with the graph, so a
 * workflow shared after an upgrade would go on claiming the version it was built with.
 * This is painted every frame from the running code, which is the only honest answer to
 * "what am I looking at?" -- and the title bar is where you already look for the name.
 */
function stampTitle(node) {
  const drawn = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    const result = drawn?.apply(this, arguments);
    if (this.flags?.collapsed) return result;
    ctx.save();
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = "#7b8494";
    ctx.textAlign = "right";
    // The title band sits above the node's own origin, so this is a negative y.
    ctx.fillText(`v${VERSION} · ${BUILD}`, this.size[0] - 10, -10);
    ctx.restore();
    return result;
  };
}

/**
 * Keep the editor as wide as the node, whatever else writes to the widget.
 *
 * ComfyUI sizes a DOM widget's element as `(widget.width ?? node.width) - margin * 2`.
 * `widget.width` is normally never set -- but opening the node properties panel renders
 * the same widget objects in its own column and stamps that column's width onto them, so
 * a 1380px editor was squeezed into 318px, wrapping the toolbar into a stack and (through
 * the resize observer below) inflating the node to a thousand pixels tall.
 *
 * A setter that drops the value rather than a per-frame correction: this runs once, and
 * there is nothing left to fight over afterwards. The panel's own row is laid out by the
 * panel and never reads this back.
 */
/** Hide a text widget's own DOM box.
 *
 * `widget.element` is the field ComfyUI wants read now; `inputEl` is the old name for the
 * same node and logs a deprecation every time it is touched. Both are checked, because a
 * pack that only reads the new one is broken on the frontends that only have the old.
 */
function hideElement(widget) {
  const box = widget.element ?? widget.inputEl;
  if (box?.style) box.style.display = "none";
}


/** The class Nodes 2.0 gives each widget row. Upstream markup, so it is checked for
 *  rather than assumed: on the canvas renderer nothing carries it. */
const VUE_ROW = ".lg-node-widget";

/** Widgets whose rows are waiting on a Vue render. One page, one observer. */
const ROW_WATCH = new Set();
let ROW_OBSERVER = null;

/** Take the settings back off the node under Nodes 2.0.
 *
 * The Vue renderer draws every widget as its own DOM row and never asks litegraph whether
 * a widget is visible -- `widget.hidden` and `computeSize` are read by the canvas and by
 * nothing else. So the five settings hidden above (timeline, width, height,
 * ref_image_size, cast) came back as full rows, JSON textareas included, and pushed the
 * editor 260px down a node that already knows its own height.
 *
 * A row carries no name, only the class every row shares, so ours is found the one way
 * that cannot be mistaken: it is the row the editor element sits inside. Every other row
 * in that grid belongs to a widget this file hides. Nothing is removed and no value is
 * touched -- a widget taken out of `node.widgets` is a widget dropped from the prompt,
 * which is how the timeline, the size and the cast would have stopped reaching the server.
 *
 * On the canvas renderer the editor is not inside a row at all, `closest` returns null,
 * and this does nothing.
 */
function hideRowsUnderVue(widget) {
  const own = widget.element?.closest?.(VUE_ROW);
  const grid = own?.parentElement;
  if (!grid) return false;
  for (const row of grid.children) {
    if (row !== own && row.style.display !== "none") row.style.display = "none";
  }
  return true;
}

/** Up into the socket band again, for the renderer that has no draw pass.
 *
 * `pullUp` does this by writing `widget.y` from `onDrawForeground`, and Nodes 2.0 never
 * calls it: the editor started below the sockets and left the band empty across the whole
 * width of a 1380px node. Here the same move is a negative top margin on our row, and the
 * same `setBand` call keeps the editor's own first row clear of the socket labels, so the
 * toolbar sits beside `clip` exactly as it does on the canvas.
 *
 * Rects come back in screen pixels, which the graph's zoom has already multiplied; the
 * margin is written inside that same transform, so the band is divided back down first.
 * The margin is read from the grid's top, not the row's: a margin on a row moves the row
 * within the grid and leaves the grid box where the layout put it, so the same band comes
 * back every frame instead of growing by the pull already applied.
 */
function pullUpUnderVue(widget) {
  const state = PULLED.get(widget);
  const own = widget.element?.closest?.(VUE_ROW);
  const grid = own?.parentElement;
  const body = grid?.parentElement;
  if (!state || !body) return;

  const scale = app.canvas?.ds?.scale || 1;
  const band = (grid.getBoundingClientRect().top - body.getBoundingClientRect().top)
    / scale;
  const pull = Math.max(0, Math.round(band - TOP_INSET));
  // Written every time rather than compared against what we think is applied: collapsing
  // the node throws the row away, and the row that comes back on expand is a new element
  // with no margin, which a remembered value would have said was already done.
  own.style.marginTop = `${-pull}px`;
  state.editor.setBand(pull, socketInset(state.node));
}

/** The build stamp, as an element rather than a `fillText`.
 *
 * `stampTitle` draws it into the canvas title band, which Nodes 2.0 does not have. The
 * node's host is positioned, so the badge is hung from its top right corner and lands in
 * the Vue title bar at the same place, in the same grey, reading the same string.
 */
function stampVersionUnderVue(widget) {
  const host = widget.element?.closest?.("[data-node-id]");
  if (!host || host.querySelector("[data-mmd-version]")) return;
  const badge = document.createElement("div");
  badge.dataset.mmdVersion = "";
  badge.textContent = `v${VERSION} · ${BUILD}`;
  badge.style.cssText = "position:absolute;top:5px;right:10px;font:10px system-ui,"
    + "sans-serif;color:#7b8494;pointer-events:none;z-index:1";
  host.appendChild(badge);
}

/** Keep all three off and on, however the grid was rebuilt.
 *
 * Vue re-renders on its own schedule -- a renderer toggle, a reload of the node's panel --
 * and a rebuilt row arrives visible, unpulled and unstamped. The one observer watches for
 * nodes appearing anywhere and answers once a frame; the work is a `closest` call, a loop
 * over six children and two rect reads, so a frame that changed nothing costs nothing.
 * Rows are hidden by style and only `childList` is watched, so this cannot call itself.
 */
function dressVueNode(widget) {
  if (!hideRowsUnderVue(widget)) return;
  // Seen in the document at least once, which is what makes "gone" meaningful below.
  const state = PULLED.get(widget);
  if (state) state.vueSeen = true;
  pullUpUnderVue(widget);
  stampVersionUnderVue(widget);
}

function watchRows(widget) {
  ROW_WATCH.add(widget);
  if (ROW_OBSERVER) { dressAll(); return; }
  let queued = false;
  ROW_OBSERVER = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      dressAll();
      // Twice more, later. Hiding a row is true whenever it is done, but the band is a
      // measurement, and the frame a rebuilt node first appears in is one where Vue has
      // not placed the grid yet: the read comes back as no band at all and the editor
      // keeps the settings' worth of empty space it was supposed to move into. An expand
      // settles well inside these two.
      requestAnimationFrame(dressAll);
      setTimeout(dressAll, 120);
    });
  });
  ROW_OBSERVER.observe(document.body, { childList: true, subtree: true });
  dressAll();
}

/** Every watched editor, and forget the ones whose node has left the graph.
 *
 * Not `isConnected`: a collapsed node has no rows in the document at all, and a widget
 * dropped from the watch on collapse is a widget nobody dresses again when it is expanded
 * -- which is how the settings came back on the second click.
 */
function dressAll() {
  for (const held of ROW_WATCH) {
    // `node.graph`, not `app.graph`: reading the app's graph before it exists is an error
    // the frontend logs. A node carries its own graph, and litegraph nulls it on removal.
    //
    // Only a node that has been dressed once and has since left the graph is finished
    // with. `onNodeCreated` runs during construction, before the graph has taken the node,
    // so a null graph on its own means "not added yet" just as often as "removed" -- and
    // reading it as "removed" dropped every editor from the watch on the frame it
    // registered, which left the settings on the node and no observer to take them off.
    const state = PULLED.get(held);
    if (state?.vueSeen && state.node.graph == null) ROW_WATCH.delete(held);
    else dressVueNode(held);
  }
}

function refuseWidthStamp(widget) {
  Object.defineProperty(widget, "width", {
    configurable: true,
    get: () => undefined,
    set: () => {},
  });
}

function growWithPrompts(node, editor, widget) {
  for (const box of editor.root.children) {
    let last = box.offsetHeight;
    new ResizeObserver(() => {
      const now = box.offsetHeight;
      // Sub-pixel churn from layout is not a resize; only a real change moves it. Nor is
      // a box that went away with its tab, or one measured at its natural height.
      if (Math.abs(now - last) < 1 || editor.measuring || now === 0 || last === 0) {
        last = now;
        return;
      }
      last = now;
      // The same exact fit as everything else. Adding the difference to the node was a
      // second opinion about the height, and two opinions is how it drifted.
      fitPulled(PULLED.get(widget) ?? { node, editor }, widget);
    }).observe(box);
  }
}
