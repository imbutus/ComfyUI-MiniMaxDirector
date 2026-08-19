/**
 * Where the caret is, and keeping it there.
 *
 * A token chip has to write at the caret, and `selectionStart` is only a trustworthy
 * answer to "where is the caret" while the box has focus. Clicking a chip blurs the box,
 * and the panel is repainted from the document whenever anything on the node changes --
 * assigning `value` puts the caret at the end even when the string is identical, and no
 * event fires to say so. That is the whole of "sometimes at the cursor, sometimes at the
 * end": it depended on whether a repaint fell between the click and the insert.
 *
 * Two halves, and both are needed. `fill` never writes a value that is already there and
 * restores the selection when it does write. `rememberCaret` records the position on every
 * interaction that could move it, so `caretOf` can hand back the place the *author* left
 * the caret rather than wherever the last repaint dropped it.
 */

/** Write a value into a text box without moving its caret. */
export const fill = (box, value) => {
  if (!box || box.value === value) return;
  const at = box.selectionStart;
  const to = box.selectionEnd;
  box.value = value;
  if (at != null) box.setSelectionRange(at, to ?? at);
};

/** Record the caret on a box, so it survives anything that happens while it is unfocused. */
export const rememberCaret = (box) => {
  if (!box) return;
  const keep = () => {
    if (box.selectionStart != null) {
      box.dataset.caret = `${box.selectionStart}:${box.selectionEnd}`;
    }
  };
  for (const type of ["keyup", "mouseup", "click", "select", "input", "focus"]) {
    box.addEventListener(type, keep);
  }
};

/**
 * The caret to write at: the live one while the box is focused, the remembered one when it
 * is not -- which is every chip click, because the click blurred it. A remembered position
 * past the end of the text is stale and is not used.
 */
export const caretOf = (box, active = null) => {
  const end = box.value.length;
  const live = [box.selectionStart ?? end, box.selectionEnd ?? box.selectionStart ?? end];
  if (box === active) return live;
  const kept = String(box.dataset?.caret ?? "").split(":").map(Number);
  if (kept.length !== 2 || !kept.every(Number.isFinite) || kept[0] > end) return live;
  return [kept[0], Math.min(kept[1], end)];
};
