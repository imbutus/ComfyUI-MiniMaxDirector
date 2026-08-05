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
import { BUILD } from "./build.js";

const NODE = "MiniMaxDirector";
const STATE_WIDGET = "timeline";

const MIN_HEIGHT = 420;
/** Matches LTXDirector, whose editor sets `size[0] = 1375` and saves at 1380x1000.
 *  A director is a workspace, not a form -- at form size the tracks are unreadable. */
const DEFAULT_SIZE = [1380, 1000];

console.info(`[MiniMaxDirector] build ${BUILD}`);

app.registerExtension({
  name: "imbutus.MiniMaxDirector",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      attach(this);
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
      requestAnimationFrame(() => fitNode(node, editor, { growOnly: true }));
    });
    return result;
  };
}

/**
 * Dragging a prompt box taller makes the node taller.
 *
 * The widget gets a fixed slice of the node, so a textarea that grows inside it takes
 * that height from the timeline -- you pull the prompt box down and the tracks shrink to
 * pay for it. Passing the change on to the node keeps everything else the size it was.
 *
 * `offsetHeight` rather than a bounding rect: the widget sits inside a CSS transform, so
 * a rect is in screen pixels while the node's size is in graph units.
 */
function growWithPrompts(node, editor) {
  for (const box of editor.root.querySelectorAll("textarea")) {
    let last = box.offsetHeight;
    new ResizeObserver(() => {
      const now = box.offsetHeight;
      const delta = now - last;
      // Sub-pixel churn from layout is not a resize; only a real drag moves it.
      if (Math.abs(delta) < 1) return;
      last = now;
      node.setSize([node.size[0], node.size[1] + delta]);
      node.graph?.setDirtyCanvas(true, true);
    }).observe(box);
  }
}
