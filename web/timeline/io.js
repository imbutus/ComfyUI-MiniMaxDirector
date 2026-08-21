/**
 * The piece as one document: saved to a file, loaded back, copied, pasted.
 *
 * A workflow carries a director node and nothing else can be handed to somebody -- so a
 * scene written on one graph could only reach another by exporting the whole workflow,
 * which brings every unrelated node with it. This is the piece alone: the timeline, the
 * cards on WHO & WHAT and the clip's own settings, in one JSON both a file and the
 * clipboard can hold.
 *
 * What it does *not* hold is the media. Files live in ComfyUI's input folder and the
 * document only names them -- the same reference a saved workflow stores. Base64 was the
 * obvious alternative and is not one: a reference video is tens of megabytes, a third
 * larger again as text, and no clipboard will take it. So an import says which files it
 * could not find and offers to upload them, which is the same work in the honest order.
 */

import * as media from "./media.js";
import { VERSION } from "../build.js";

/** What the file says it is, so a JSON from somewhere else is refused by name. */
export const FORMAT = "minimax-director";

/** The document's own shape, which is not the extension's version. */
export const DOCUMENT = 1;

/** The piece, ready to be written out. */
export function bundle({ timeline, cast, settings }) {
  return {
    format: FORMAT,
    version: DOCUMENT,
    // Which pack wrote it, for a bug report. Never read on the way back in: a document is
    // read by its shape, and refusing one for the version that wrote it would age every
    // file somebody saved.
    pack: VERSION,
    written: new Date().toISOString(),
    settings,
    timeline,
    cast,
  };
}

/**
 * A written document back into its three parts.
 *
 * Throws with a sentence fit to show, because every caller has a status line and nothing
 * useful to add to a stack trace. A bare timeline -- what the node's hidden widget holds
 * -- is accepted too: it is the JSON somebody is most likely to have on their clipboard,
 * and refusing it to insist on an envelope would be pedantry.
 */
export function unbundle(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return fail("that is not JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return fail("that JSON is not a document");
  }

  if (!payload.timeline && (Array.isArray(payload.shots) || Array.isArray(payload.cues))) {
    return { timeline: payload, cast: null, settings: null, bare: true };
  }
  if (payload.format && payload.format !== FORMAT) {
    return fail(`that file says it is ${payload.format}, not ${FORMAT}`);
  }
  if (!payload.timeline || typeof payload.timeline !== "object") {
    return fail("there is no timeline in that document");
  }

  return {
    timeline: payload.timeline,
    cast: object(payload.cast),
    settings: object(payload.settings),
    bare: false,
  };
}

const fail = (why) => { throw new Error(why); };
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;

/** `minimax-director-2026-08-21.json`, which sorts by date in a folder. */
export function filename(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `minimax-director-${now.getFullYear()}-${pad(now.getMonth() + 1)}`
    + `-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
}

/**
 * Write the text to a file the author picks, and answer with the name it was given.
 *
 * A plain download is the fallback, not the intent: Chrome takes it straight to whatever
 * folder it was last told to use, with no dialog, no choice of name and nothing on screen
 * -- which reads exactly like a button that did nothing. Where the browser has a save
 * picker, that is what this uses. Firefox and Safari do not, and fall through.
 *
 * `null` means the picker was dismissed, which is an answer, not a failure.
 */
export async function save(text, name = filename()) {
  const blob = new Blob([text], { type: "application/json" });

  if (window.showSaveFilePicker) {
    let handle = null;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{
          description: "MiniMax Director piece",
          accept: { "application/json": [".json"] },
        }],
      });
    } catch (error) {
      if (error?.name === "AbortError") return null;
      // Anything else -- a context the picker refuses to open in, a permission withheld --
      // is not worth an error message when a download does the same job.
      handle = null;
    }
    if (handle) {
      const stream = await handle.createWritable();
      await stream.write(blob);
      await stream.close();
      return handle.name;
    }
  }

  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  // Not in the same tick: revoking the URL before the browser has read it cancels the
  // download, and the failure looks exactly like a button that does nothing.
  setTimeout(() => URL.revokeObjectURL(link.href), 20000);
  return name;
}

/** A chosen `.json`, read as text, or null when the picker was dismissed. */
export function load() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, text: await file.text() } : null);
    };
    input.click();
  });
}

/** Media files, several at once: an import is missing a folder, not a file. */
export function pickFiles() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/*,audio/*,video/*";
    input.onchange = () => resolve([...(input.files || [])]);
    input.click();
  });
}

/**
 * Text onto the system clipboard.
 *
 * The modern call needs a secure context and a permission the browser may refuse, and a
 * refusal here is not a reason to leave somebody without their document -- so a hidden
 * textarea and the old command answer for it.
 */
export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement("textarea");
    box.value = text;
    box.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(box);
    box.select();
    let done = false;
    try {
      done = document.execCommand("copy");
    } catch {
      done = false;
    }
    box.remove();
    return done;
  }
}

// There is no `paste()` here on purpose. Reading the clipboard from a page is a permission
// -- Chrome grants it silently, Firefox puts its own popup in front of it -- while pasting
// into a box needs none, because the paste *is* the permission. The Paste button opens a
// box and loads what lands in it.

/** Every media record in a timeline, as live references so they can be re-pointed. */
export function mediaOf(timeline) {
  const found = [];
  for (const track of ["shots", "cues", "moves"]) {
    for (const item of timeline?.[track] || []) {
      if (item?.media?.filename) found.push(item.media);
    }
  }
  for (const record of timeline?.sources || []) {
    if (record?.filename) found.push(record);
  }
  return found;
}

/**
 * Which of these files ComfyUI does not have.
 *
 * Asked of the same endpoint the editor draws them from, with HEAD: the answer is 404 or
 * 200 and no bytes cross the wire. A network error is not evidence the file is gone --
 * reporting the whole cast as missing because the server blinked would send somebody
 * hunting for files that are sitting right there -- so only a real 404 counts.
 */
export async function missing(records) {
  const asked = new Map();
  const present = (record) => {
    const url = media.url(record);
    if (!url) return Promise.resolve(true);
    if (!asked.has(url)) {
      // `no-store`, and it matters: the same URL was fetched to draw the thumbnail, so a
      // cached 200 would answer for a file that has since been deleted -- the one case
      // this exists to catch.
      asked.set(url, fetch(url, { method: "HEAD", cache: "no-store" })
        .then((response) => response.status !== 404)
        .catch(() => true));
    }
    return asked.get(url);
  };
  const checked = await Promise.all(
    records.map(async (record) => (await present(record) ? null : record)));
  return checked.filter(Boolean);
}

/**
 * Upload the chosen files and point the document at them.
 *
 * Matched by name, because the name is what the document is holding. Several blocks share
 * one file often enough -- a face on three shots -- so a match re-points every record
 * naming it from a single upload.
 *
 * The name that comes back is not always the name that went up: `overwrite=false` means
 * ComfyUI renames a collision rather than replacing a file that some other workflow is
 * using. Writing the returned name back is what keeps the document true either way.
 */
export async function restore(records, files) {
  const wanted = new Map();
  for (const record of records) {
    const key = String(record.filename || "");
    if (!wanted.has(key)) wanted.set(key, []);
    wanted.get(key).push(record);
  }
  const keyed = new Map([...wanted.keys()].map((name) => [name.toLowerCase(), name]));

  const placed = [];
  const renamed = [];
  const spare = [];
  for (const file of files) {
    const key = keyed.get(file.name.toLowerCase());
    if (!key) {
      spare.push(file);
      continue;
    }
    const { to } = await put(wanted.get(key), file);
    if (to !== key) renamed.push({ from: key, to });
    wanted.delete(key);
    keyed.delete(file.name.toLowerCase());
    placed.push(file.name);
  }

  // One file still missing and one file offered that answers to no name: it is that file.
  // Renamed on disk is the ordinary reason a file goes missing, so insisting on the old
  // name here would refuse the very case somebody is trying to repair -- and with one of
  // each there is nothing to guess at. Two of each is a guess, and a wrong guess points a
  // block at somebody else's photograph, so those are left for the per-row button, where
  // the row says which file it is asking about.
  if (wanted.size === 1 && spare.length === 1) {
    const key = [...wanted.keys()][0];
    const { to } = await put(wanted.get(key), spare[0]);
    if (to !== key) renamed.push({ from: key, to });
    wanted.delete(key);
    placed.push(spare[0].name);
  }

  return { placed, left: [...wanted.keys()], renamed };
}

/**
 * One chosen file for one named file, whatever the chosen one is called.
 *
 * The row already says which file is missing, so the pick answers that row -- matching by
 * name here would refuse the obvious case, which is a file that was renamed on disk and is
 * exactly why the row is asking. Answers with both names: a card points at a file by name
 * too, and the caller has to carry the new one over.
 */
export async function put(records, file) {
  const from = String(records[0]?.filename || "");
  const uploaded = await media.upload(
    records[0]?.kind || media.kindOf(file) || "image", file);
  for (const record of records) {
    record.filename = uploaded.filename;
    record.subfolder = uploaded.subfolder;
  }
  return { from, to: uploaded.filename };
}
