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
import { install } from "./timeline/styles.js";
import { BUILD } from "./build.js";

const NODE = "MiniMaxDirector";
const PROMPT_NODE = "MiniMaxDirectorPrompt";
const STATE_WIDGET = "timeline";
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

const MIN_HEIGHT = 420;
/** Matches LTXDirector, whose editor sets `size[0] = 1375` and saves at 1380x1000.
 *  A director is a workspace, not a form -- at form size the tracks are unreadable. */
const DEFAULT_SIZE = [1380, 1000];

console.info(`[MiniMaxDirector] build ${BUILD}`);

app.registerExtension({
  name: "imbutus.MiniMaxDirector",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE && nodeData.name !== PROMPT_NODE) return;

    const mount = nodeData.name === NODE ? attach : attachPromptView;
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
    requestAnimationFrame(() => fitNode(node, editor));
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
function centreOnNode(node) {
  const canvas = app.canvas;
  const view = canvas?.ds;
  const element = canvas?.canvas;
  if (!view?.offset || !element?.clientWidth) return;

  // Only when it is not already in front of you. `onConfigure` fires for every rebuild of
  // the node, and ComfyUI's undo *is* a rebuild -- so this used to yank the canvas back to
  // centre on every Cmd+Z, throwing away wherever the author had panned to. Asking whether
  // the node is visible answers both cases with one rule: a workflow that just opened has
  // it off-screen, an undo does not, and the canvas keeps its own position through the
  // rebuild anyway.
  const middle = [
    (node.pos[0] + node.size[0] / 2 + view.offset[0]) * view.scale,
    (node.pos[1] + node.size[1] / 2 + view.offset[1]) * view.scale,
  ];
  const inside = middle[0] > 0 && middle[0] < element.clientWidth
    && middle[1] > 0 && middle[1] < element.clientHeight;
  if (inside) return;

  view.offset[0] = element.clientWidth / 2 / view.scale - (node.pos[0] + node.size[0] / 2);
  view.offset[1] = element.clientHeight / 2 / view.scale - (node.pos[1] + node.size[1] / 2);
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
      // Sub-pixel churn from layout is not a resize; only a real change moves it.
      if (Math.abs(delta) < 1) return;
      last = now;
      node.setSize([node.size[0], node.size[1] + delta]);
      node.graph?.setDirtyCanvas(true, true);
    }).observe(box);
  }
}
