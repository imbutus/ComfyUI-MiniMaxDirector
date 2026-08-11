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
import { BUILD } from "./build.js";

const NODE = "MiniMaxDirector";
const PROMPT_NODE = "MiniMaxDirectorPrompt";
const CAST_NODE = "MiniMaxDirectorCast";
const STATE_WIDGET = "timeline";
const CAST_WIDGET = "cast";
const PROMPT_VIEW = "compiled_prompt";
/** Wide enough to read a compiled shot without wrapping every few words. */
const PROMPT_SIZE = [520, 420];
/** A card is a face and three sentences: wide, and only as tall as the cast is long. */
const CAST_SIZE = [860, 150];
/** An empty cast is one line of text. Below this the title bar starts eating the list. */
const CAST_MIN_HEIGHT = 110;

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

/** Height for a pulled-up editor: the content, plus the inset it now starts at. */
function fitPulled(state, widget) {
  const root = state.editor.root;
  const margin = widget.margin ?? 0;
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
  const target = TOP_INSET + content + margin * 2;
  if (Math.abs(target - state.node.size[1]) < 2) return;
  state.node.setSize([state.node.size[0], Math.max(MIN_HEIGHT, Math.round(target))]);
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
      if (!held.element?.isConnected) { PULLED.delete(held); continue; }
      // The first frame's own value *is* the band: whatever the layout reserved for the
      // sockets is exactly what the editor now has to stay clear of.
      const learned = held.y > TOP_INSET;
      if (learned) state.band = held.y;
      held.y = TOP_INSET;
      state.editor.setBand(state.band - TOP_INSET);

      // Height as well as position. The layout still reserves the band, so the element's
      // own height is computed as if it began below the sockets -- moved up and left at
      // that height it would stop short, leaving the band's worth of empty node under it.
      // The frontend takes the margin off this itself (`computedHeight - margin * 2`),
      // so taking it off here as well left the element two margins short of the node.
      held.computedHeight = Math.max(MIN_HEIGHT, state.node.size[1] - TOP_INSET);

      // And the node itself only needed that height because the editor started low.
      // Sized from the content rather than by subtracting the band: `fitNode` compares
      // against the element's own height, and for the frames right after a resize that
      // height is still the old one -- which is how the globals ended up clipped.
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
    const mounts = { [NODE]: attach, [PROMPT_NODE]: attachPromptView, [CAST_NODE]: attachCast };
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
  if (json.inputEl) json.inputEl.style.display = "none";

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
    if (cast.inputEl) cast.inputEl.style.display = "none";
    if (!cast.value?.trim()) cast.value = JSON.stringify(EMPTY_CAST, null, 2);
  }

  editor.castJSON = () => {
    const wired = castNodeOf(node);
    return (wired ? castValue(wired) : cast?.value) || "";
  };
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
    // Editing the cast changes the compiled prompt and the block's chips, and neither
    // knows the tab exists.
    inside.onChange = () => {
      editor.schedulePreview();
      editor.paintPicker(editor.read());
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
      const state = PULLED.get(widget) ?? { node, editor };
      requestAnimationFrame(() => {
        fitPulled(state, widget);
        requestAnimationFrame(() => fitPulled(state, widget));
      });
    };
    node.castEditor = inside;
    requestAnimationFrame(() => {
      inside.render();
      editor.paintTabCount(parseCast(cast.value).cards.length);
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

  // Up into the socket band: ten input labels reserved 200px of node that nothing was
  // ever drawn in.
  pullUp(node, widget, editor);

  // Open at workspace size. A saved graph overwrites this afterwards, so a node the
  // user has resized keeps its own dimensions.
  node.setSize([
    Math.max(node.size?.[0] ?? 0, DEFAULT_SIZE[0]),
    Math.max(node.size?.[1] ?? 0, DEFAULT_SIZE[1]),
  ]);

  growWithPrompts(node, editor);
  fitAfterLoad(node, editor);

  // The first render needs a laid-out element to measure, so wait one frame.
  requestAnimationFrame(() => {
    editor.render();
    // Twice: the first pass resizes the node, and the widget's own height only follows
    // on the frame after that, so the second pass settles the remainder.
    fitNode(node, editor);
    requestAnimationFrame(() => {
      fitNode(node, editor);
      // Last, and only now: switching tabs measures the timeline on the way out, so the
      // panel inherits its height instead of opening at whatever it happens to need.
      const tab = node.properties?.tab;
      if (tab && tab !== "timeline") editor.showTab(tab);
    });
  });
}

/**
 * Carry the selection across a rebuild of the node.
 *
 * The editor reports its state after every panel render; the last report for this node id
 * is handed back to whatever editor is mounted next. The view state travels with it --
 * the playhead and the zoom are equally annoying to lose, and for the same reason.
 */
function remember(node, editor) {
  // A frame late, and deliberately: `onNodeCreated` runs during construction, before the
  // graph has given the node its id. Reading it now would look up -1 and find nothing.
  // This callback is registered before the one that renders, so it still lands first.
  requestAnimationFrame(() => {
    const saved = SELECTION.get(node.id);
    if (!saved) return;
    editor.selection = saved.selection;
    editor.selected = saved.selected;
    editor.playhead = saved.playhead;
    editor.zoom = saved.zoom;
  });

  editor.onState = (source) => SELECTION.set(node.id, {
    selection: source.selection,
    selected: [...source.selected],
    playhead: source.playhead,
    zoom: source.zoom,
  });
}

/**
 * Give a `MiniMaxDirectorPrompt` node a box to show the compiled prompt in.
 *
 * The widget is ours rather than the one ComfyUI builds for a text preview, because this
 * node has to show a string that no run produced. `install()` is called here as well as
 * by the editor: a graph can hold this node with no director on the canvas yet, and the
 * stylesheet goes in once either way.
 */
function attachPromptView(node) {
  install();

  const root = document.createElement("div");
  root.className = "mmd-prompt-view";
  root.innerHTML = `
    <label>COMPILED PROMPT <span class="mmd-hint">what the model actually receives</span></label>
    <pre class="mmd-prompt-text" tabindex="0"></pre>`;

  node.addDOMWidget(PROMPT_VIEW, "minimax_director_prompt", root, {
    getMinHeight: () => 120,
    hideOnZoom: false,
    serialize: false,
    getValue: () => undefined,
    setValue: () => {},
  }).serializeValue = () => undefined;

  node.promptView = root.querySelector(".mmd-prompt-text");
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
    if (text?.length) paintPromptView(node, { ok: true, prompt: text.join("") });
  };

  // Wiring it up mid-session should show the prompt at once rather than on the next
  // keystroke, so ask whichever director now feeds it for what it last compiled.
  const connections = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    const result = connections?.apply(this, arguments);
    for (const director of app.graph?._nodes ?? []) {
      if (director.type !== NODE || !director.timelineEditor) continue;
      if (!promptViewsOf(director).includes(node)) continue;
      if (director.timelineEditor.preview) {
        paintPromptView(node, director.timelineEditor.preview);
      }
    }
    return result;
  };
}

/**
 * Give a `MiniMaxDirectorCast` node its list of cards.
 *
 * The cast reads the director's timeline for the files a character can be drawn out of,
 * and writes only its own JSON. The compiler folds the two together (`cast.py`), so the
 * link is what makes a card mean anything -- unwired, the node says so rather than
 * offering a file picker with nothing in it.
 */
function attachCast(node) {
  const json = node.widgets?.find((widget) => widget.name === CAST_WIDGET);
  if (!json) return;

  json.hidden = true;
  json.computeSize = () => [0, -4];
  if (json.inputEl) json.inputEl.style.display = "none";

  const editor = new CastEditor(
    () => parseCast(json.value),
    (state) => { json.value = JSON.stringify(state, null, 2); },
    () => {
      const director = directorOf(node);
      const widget = director?.widgets?.find((w) => w.name === STATE_WIDGET);
      return widget ? parse(widget.value) : null;
    },
  );
  if (!json.value?.trim()) json.value = JSON.stringify(EMPTY_CAST, null, 2);

  node.castEditor = editor;

  // A card only becomes visible in the prompt once the director recompiles, and the
  // director has no way of knowing this node was typed into.
  editor.onChange = () => {
    const director = directorOf(node);
    director?.timelineEditor?.schedulePreview();
    director?.timelineEditor?.render();
  };

  const widget = node.addDOMWidget(CAST_WIDGET + "_editor", "minimax_director_cast",
                                   editor.root, {
    getMinHeight: () => 160,
    hideOnZoom: false,
    serialize: false,
    getValue: () => undefined,
    setValue: () => {},
  });
  widget.serializeValue = () => undefined;

  node.setSize([
    Math.max(node.size?.[0] ?? 0, CAST_SIZE[0]),
    Math.max(node.size?.[1] ?? 0, CAST_SIZE[1]),
  ]);

  // As tall as the cast, and no taller. A fixed height left a band of empty node under
  // one card, which is the space the director needs on a screen that already does not
  // have enough of it.
  const fit = () => fitCast(node, editor);
  editor.onResize = fit;

  // Wiring it up mid-session should fill the file picker at once rather than on the next
  // keystroke, and the director's chips should learn about the cast the same moment.
  const connections = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    const result = connections?.apply(this, arguments);
    requestAnimationFrame(() => {
      editor.shape = null;
      editor.render();
      editor.onChange?.();
    });
    return result;
  };

  requestAnimationFrame(() => {
    editor.render();
    fit();
    requestAnimationFrame(fit);
  });
}

/**
 * Shrink a cast node to its cards.
 *
 * The same measurement `fitNode` makes for the director, minus the grow-only guard: a
 * cast that loses a character should give the height back, because the reason this node
 * exists is that the director had none to spare.
 */
function fitCast(node, editor) {
  const root = editor.root;
  const style = getComputedStyle(root);
  const gap = parseFloat(style.rowGap) || 0;
  const kids = [...root.children];
  const needed = kids.reduce((sum, el) => sum + el.offsetHeight, 0) + gap * (kids.length - 1);

  const delta = Math.round(needed - root.clientHeight);
  if (Math.abs(delta) < 2) return;
  node.setSize([node.size[0], Math.max(CAST_MIN_HEIGHT, node.size[1] + delta)]);
  node.graph?.setDirtyCanvas(true, true);
}

/** The director this cast node feeds, or null while it is unwired. */
function directorOf(cast) {
  const graph = cast.graph ?? app.graph;
  for (const output of cast.outputs ?? []) {
    for (const id of output.links ?? []) {
      const target = graph?.getNodeById?.(graph?.links?.[id]?.target_id);
      if (target?.widgets?.some((widget) => widget.name === STATE_WIDGET)) return target;
    }
  }
  return null;
}

/** The cast node feeding `director`, or null. */
function castNodeOf(director) {
  const graph = director.graph ?? app.graph;
  for (const input of director.inputs ?? []) {
    if (input.name !== CAST_WIDGET || input.link == null) continue;
    const source = graph?.getNodeById?.(graph?.links?.[input.link]?.origin_id);
    if (source) return source;
  }
  return null;
}

/** A cast node's stored JSON, whatever the node turns out to be. */
function castValue(node) {
  return node?.widgets?.find((widget) => widget.name === CAST_WIDGET)?.value || "";
}

/** The prompt nodes wired to `director`, in graph order. */
function promptViewsOf(director) {
  const graph = director.graph ?? app.graph;
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
  node.promptView.textContent = result.ok
    ? result.prompt
    : `could not compile: ${result.error}`;
  node.graph?.setDirtyCanvas(true, true);
}

/**
 * Make the node exactly as tall as the editor wants to be.
 *
 * Every part of the editor now has a height of its own -- the stage is its tracks, the
 * prompt boxes are their text. Left at a fixed node height the difference shows up as
 * dead grey space, and the size to open at stops being a guess only when it is measured.
 */
function fitNode(node, editor, { growOnly = false } = {}) {
  const style = getComputedStyle(editor.root);
  const gap = parseFloat(style.rowGap) || 0;
  const kids = [...editor.root.children];
  const needed = kids.reduce((sum, el) => sum + el.offsetHeight, 0) + gap * (kids.length - 1);

  const delta = Math.round(needed - editor.root.clientHeight);
  if (Math.abs(delta) < 2 || (growOnly && delta < 0)) return;
  node.setSize([node.size[0], Math.max(MIN_HEIGHT, node.size[1] + delta)]);
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
function fitAfterLoad(node, editor) {
  const configured = node.onConfigure;
  node.onConfigure = function (info) {
    const result = configured?.apply(this, arguments);
    requestAnimationFrame(() => {
      fitNode(node, editor, { growOnly: true });
      requestAnimationFrame(() => {
        fitNode(node, editor, { growOnly: true });
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
/** Where the director's top-left corner should sit on screen, in pixels. */
const MARGIN = [116, 146];

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
function growWithPrompts(node, editor) {
  for (const box of editor.root.children) {
    let last = box.offsetHeight;
    new ResizeObserver(() => {
      const now = box.offsetHeight;
      const delta = now - last;
      // Sub-pixel churn from layout is not a resize; only a real change moves it. Nor is
      // a box that went away with its tab, or one measured at its natural height.
      if (Math.abs(delta) < 1 || editor.measuring || now === 0 || last === 0) {
        last = now;
        return;
      }
      last = now;
      node.setSize([node.size[0], node.size[1] + delta]);
      node.graph?.setDirtyCanvas(true, true);
    }).observe(box);
  }
}
