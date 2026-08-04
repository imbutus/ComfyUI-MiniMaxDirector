/**
 * The MiniMaxDirector timeline widget.
 *
 * Registers one custom widget on the `MiniMaxDirector` node and hides the raw JSON
 * string widget behind it. The JSON stays the only stored state -- the widget reads it
 * on draw and writes it back on every edit -- so a graph saved with this extension
 * installed still loads, and still runs, without it.
 */

import { app } from "../../scripts/app.js";
import * as model from "./timeline/model.js";
import { draw, layout } from "./timeline/view.js";
import { widgetHeight } from "./timeline/theme.js";
import { applyDrag, beginDrag, hitTest } from "./timeline/interactions.js";

const NODE = "MiniMaxDirector";
const STATE_WIDGET = "timeline";
const TRACKS = 2;

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
  json.hidden = true;
  json.computeSize = () => [0, -4];

  const state = { selection: null, drag: null, geometry: null };

  const read = () => model.parse(json.value);
  const write = (timeline) => {
    json.value = model.serialize(timeline);
    node.setDirtyCanvas(true, true);
  };

  const widget = node.addCustomWidget({
    name: "director",
    type: "minimax_director",
    value: null,

    computeSize: (width) => [width, widgetHeight(TRACKS)],

    draw(ctx, owner, width, y) {
      const timeline = read();
      const height = widgetHeight(TRACKS);
      ctx.save();
      ctx.translate(0, y);
      state.geometry = layout(timeline, width, height);
      draw(ctx, timeline, state.geometry, state);
      ctx.restore();
      this.last_y = y;
    },

    mouse(event, pos) {
      const geometry = state.geometry;
      if (!geometry) return false;

      const x = pos[0];
      const y = pos[1] - (this.last_y ?? 0);
      const timeline = read();

      if (event.type === "pointerdown") {
        const hit = hitTest(geometry, x, y);
        state.selection = hit && hit.index !== null ? hit : null;
        state.drag = beginDrag(timeline, hit, x, geometry);
        node.setDirtyCanvas(true, true);
        return Boolean(hit);
      }

      if (event.type === "pointermove" && state.drag) {
        if (applyDrag(timeline, state.drag, x)) write(timeline);
        return true;
      }

      if (event.type === "pointerup") {
        const dragged = Boolean(state.drag);
        state.drag = null;
        return dragged;
      }

      return false;
    },

    // The custom widget holds no state of its own; the JSON widget is serialised.
    serializeValue: () => null,
  });

  widget.serialize = false;

  node.addWidget("button", "add shot", null, () => write(model.addShot(read())));
  node.addWidget("button", "add audio cue", null, () => write(model.addCue(read())));
  node.addWidget("button", "remove selected", null, () => {
    if (!state.selection || state.selection.index === null) return;
    const timeline = model.removeItem(read(), state.selection.track, state.selection.index);
    state.selection = null;
    write(timeline);
  });
}
