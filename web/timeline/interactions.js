/**
 * Pointer handling: select, move, resize.
 *
 * Hit-testing reads the same geometry object the view drew, so a click always lands on
 * what the eye sees. Drags are expressed in frames rather than pixels, which keeps the
 * result identical at any zoom level.
 */

import { metrics } from "./theme.js";
import { reshape } from "./model.js";

const EDGE = "edge";
const BODY = "body";

/** Which item, if any, is under `(x, y)` — and whether the pointer is on a handle. */
export function hitTest(geometry, x, y) {
  for (const band of geometry.bands) {
    if (y < band.y || y > band.y + band.height) continue;

    for (const rect of band.rects) {
      if (x < rect.x || x > rect.x + rect.width) continue;

      const fromLeft = x - rect.x;
      const fromRight = rect.x + rect.width - x;
      const grip = Math.min(metrics.handleWidth + 2, rect.width / 3);

      if (fromLeft <= grip) return { track: band.track, index: rect.index, part: EDGE, side: "start" };
      if (fromRight <= grip) return { track: band.track, index: rect.index, part: EDGE, side: "end" };
      return { track: band.track, index: rect.index, part: BODY };
    }
    return { track: band.track, index: null, part: null };
  }
  return null;
}

/** Snapshot the item being dragged, so the gesture is applied to its original bounds. */
export function beginDrag(timeline, hit, x, geometry) {
  if (!hit || hit.index === null) return null;
  const item = timeline[hit.track][hit.index];
  return {
    ...hit,
    originX: x,
    scale: geometry.scale,
    start: item.start,
    length: item.length,
  };
}

/** Apply an in-progress drag. Mutates the item and returns true when it changed. */
export function applyDrag(timeline, drag, x) {
  if (!drag) return false;

  const frames = Math.round((x - drag.originX) / drag.scale);
  if (frames === 0) return false;

  const item = timeline[drag.track][drag.index];

  if (drag.part === BODY) {
    reshape(item, { start: drag.start + frames });
    return true;
  }

  if (drag.side === "start") {
    const start = Math.min(drag.start + frames, drag.start + drag.length - 1);
    reshape(item, { start, length: drag.length - (start - drag.start) });
    return true;
  }

  reshape(item, { length: drag.length + frames });
  return true;
}
