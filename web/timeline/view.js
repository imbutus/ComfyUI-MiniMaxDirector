/**
 * Drawing the timeline.
 *
 * One canvas, no DOM overlay, no dependencies. The widget draws into the canvas
 * ComfyUI already gives every node, which keeps the editor light and means it pans,
 * zooms and screenshots with the rest of the graph for free.
 *
 * `layout()` is the single source of geometry; the view draws it and the interaction
 * layer hit-tests it, so what is seen and what is clickable cannot drift apart.
 */

import { metrics, theme, widgetHeight } from "./theme.js";
import { formatSeconds, length as clipLength, toSeconds } from "./model.js";

/** Geometry for one render: where every track and item sits, in pixels. */
export function layout(timeline, width, height) {
  const { padding, rulerHeight, trackHeight, trackGap } = metrics;
  const total = Math.max(clipLength(timeline), 1);
  const left = padding;
  const usable = Math.max(1, width - padding * 2);
  const scale = usable / total;

  const rows = [
    { track: "shots", items: timeline.shots },
    { track: "cues", items: timeline.cues },
  ];

  const bands = rows.map((row, index) => ({
    ...row,
    y: padding + rulerHeight + index * (trackHeight + trackGap),
    height: trackHeight,
    rects: row.items.map((item, itemIndex) => ({
      index: itemIndex,
      item,
      x: left + item.start * scale,
      width: Math.max(2, item.length * scale),
    })),
  }));

  return { left, usable, scale, total, bands, width, height, rulerY: padding };
}

export function draw(ctx, timeline, geometry, state) {
  ctx.save();
  ctx.font = metrics.font;
  ctx.textBaseline = "middle";

  drawRuler(ctx, geometry);
  for (const band of geometry.bands) {
    drawBand(ctx, band, geometry, state);
  }

  ctx.restore();
}

function drawRuler(ctx, geometry) {
  const { left, usable, total, rulerY } = geometry;
  const seconds = Math.max(1, Math.ceil(toSeconds(total)));
  const step = seconds <= 12 ? 1 : Math.ceil(seconds / 12);

  ctx.strokeStyle = theme.rulerTick;
  ctx.fillStyle = theme.ruler;
  ctx.lineWidth = 1;

  for (let second = 0; second <= seconds; second += step) {
    const x = left + (second / toSeconds(total)) * usable;
    if (x > left + usable) break;
    ctx.beginPath();
    ctx.moveTo(x, rulerY + 4);
    ctx.lineTo(x, rulerY + metrics.rulerHeight - 2);
    ctx.stroke();
    ctx.fillText(`${second}s`, x + 3, rulerY + 7);
  }
}

function drawBand(ctx, band, geometry, state) {
  const { left, usable } = geometry;

  ctx.fillStyle = theme.track;
  ctx.strokeStyle = theme.trackBorder;
  rounded(ctx, left, band.y, usable, band.height, metrics.radius);
  ctx.fill();
  ctx.stroke();

  for (const rect of band.rects) {
    const active =
      state.selection &&
      state.selection.track === band.track &&
      state.selection.index === rect.index;

    ctx.fillStyle = band.track === "shots"
      ? (active ? theme.shotActive : theme.shot)
      : (active ? theme.cueActive : theme.cue);
    rounded(ctx, rect.x, band.y, rect.width, band.height, metrics.radius);
    ctx.fill();

    if (active) {
      ctx.fillStyle = theme.handle;
      ctx.fillRect(rect.x, band.y, metrics.handleWidth, band.height);
      ctx.fillRect(rect.x + rect.width - metrics.handleWidth, band.y, metrics.handleWidth, band.height);
    }

    drawLabel(ctx, rect, band);
  }
}

function drawLabel(ctx, rect, band) {
  const text = rect.item.prompt?.trim() || `${formatSeconds(rect.item.length / 24)}s`;
  if (rect.width < 28) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x + 6, band.y, rect.width - 12, band.height);
  ctx.clip();
  ctx.fillStyle = theme.text;
  ctx.fillText(text, rect.x + 8, band.y + band.height / 2);
  ctx.restore();
}

function rounded(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

export { widgetHeight };
