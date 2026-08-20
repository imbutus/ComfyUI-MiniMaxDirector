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

/** Hand the text to the browser as a download. */
export function save(text, name = filename()) {
  const blob = new Blob([text], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  // Not in the same tick: revoking the URL before the browser has read it cancels the
  // download, and the failure looks exactly like a button that does nothing.
  setTimeout(() => URL.revokeObjectURL(link.href), 20000);
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

/** What the clipboard holds. Throws when the browser will not say, which it may. */
export async function paste() {
  const text = await navigator.clipboard.readText();
  return text;
}

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
      asked.set(url, fetch(url, { method: "HEAD" })
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
    const key = String(record.filename || "").toLowerCase();
    if (!wanted.has(key)) wanted.set(key, []);
    wanted.get(key).push(record);
  }

  const placed = [];
  for (const file of files) {
    const group = wanted.get(file.name.toLowerCase());
    if (!group) continue;
    const uploaded = await media.upload(
      group[0].kind || media.kindOf(file) || "image", file);
    for (const record of group) {
      record.filename = uploaded.filename;
      record.subfolder = uploaded.subfolder;
    }
    wanted.delete(file.name.toLowerCase());
    placed.push(file.name);
  }

  return { placed, left: [...wanted.values()].map((group) => group[0].filename) };
}
