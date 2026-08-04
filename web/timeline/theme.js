/**
 * Colours and metrics for the timeline widget.
 *
 * Kept in one object so the widget can be restyled without reading the drawing code,
 * and so light and dark ComfyUI themes stay one assignment apart.
 */

export const theme = {
  track: "#1c1f26",
  trackBorder: "#2c313c",
  ruler: "#6b7280",
  rulerTick: "#3a4150",
  shot: "#2f6d8f",
  shotActive: "#3f93bd",
  cue: "#7a5b2e",
  cueActive: "#a67c3d",
  handle: "#cbd5e1",
  text: "#e5e7eb",
  textMuted: "#9ca3af",
  warning: "#c98a2b",
  error: "#c3564b",
};

export const metrics = {
  padding: 8,
  rulerHeight: 16,
  trackHeight: 30,
  trackGap: 6,
  handleWidth: 5,
  radius: 4,
  font: "11px system-ui, sans-serif",
};

/** Height the widget needs for the tracks it draws. */
export function widgetHeight(trackCount) {
  const { padding, rulerHeight, trackHeight, trackGap } = metrics;
  return padding * 2 + rulerHeight + trackCount * (trackHeight + trackGap);
}
