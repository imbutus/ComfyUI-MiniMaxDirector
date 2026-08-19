/**
 * Where a token chip writes.
 *
 * The rule: at the caret the author left, every time -- including the first click after a
 * repaint, which is the one that used to append at the end.
 *
 *   node tests/js/caret.test.mjs
 */

import { caretOf, fill, rememberCaret } from "../../web/timeline/caret.js";

let failures = 0;
const check = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.error(`FAIL ${name}: got ${a}, want ${b}`); failures++; }
};

// A textarea, as much of one as this needs: a value, a selection, and listeners.
const box = (value, at = 0, to = at) => {
  const el = {
    value, selectionStart: at, selectionEnd: to, dataset: {}, listeners: {},
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    fire(type) { for (const fn of el.listeners[type] || []) fn(); },
    setSelectionRange(a, b) { el.selectionStart = a; el.selectionEnd = b; },
  };
  return el;
};

// --- fill -------------------------------------------------------------------------------
const same = box("words of exactly", 9);
fill(same, "words of exactly");
check("an identical write is not made at all", [same.selectionStart, same.selectionEnd], [9, 9]);

const changed = box("words of exactly", 9);
fill(changed, "words of exactly, and more");
check("a real write keeps the caret", [changed.selectionStart, changed.selectionEnd], [9, 9]);

// --- the caret to write at --------------------------------------------------------------
const focused = box("abcdef", 3);
check("focused: the live caret", caretOf(focused, focused), [3, 3]);

const typed = box("words of exactly", 9);
rememberCaret(typed);
typed.fire("keyup");                 // the author leaves the caret at 9
typed.selectionStart = typed.selectionEnd = typed.value.length;  // a repaint drops it at the end
check("unfocused: the remembered caret, not the repaint's", caretOf(typed, null), [9, 9]);

const never = box("abcdef", 2);
check("nothing remembered: the live caret", caretOf(never, null), [2, 2]);

const stale = box("short", 0);
stale.dataset.caret = "40:40";
check("a remembered caret past the end is ignored", caretOf(stale, null), [0, 0]);

const clipped = box("abcdef", 0);
clipped.dataset.caret = "2:99";
check("a remembered end past the text is clipped", caretOf(clipped, null), [2, 6]);

console.log(failures ? `${failures} failed` : "caret: all good");
process.exit(failures ? 1 : 0);
