/**
 * The timeline editor: a DOM widget, not a canvas painting.
 *
 * Canvas drawing inside the node was the wrong shape for this. A director needs to be
 * big, to scroll, to hold text inputs and eventually media thumbnails -- all of which
 * the DOM gives for free and a canvas would have to reimplement badly.
 *
 * One rule keeps it honest: the JSON is the only state. Every edit writes it back
 * immediately, and every render reads it fresh. There is no second copy to fall out of
 * sync, and a graph saved without this extension still carries a complete timeline.
 */

import { install } from "./styles.js";
import {
  CAMERAS, TRACKS, add, formatSeconds, items, length, remove, reshape, toSeconds,
} from "./model.js";

const EDGE = 7;

export class TimelineEditor {
  /**
   * @param {() => object} read   parse the JSON widget
   * @param {(t: object) => void} write  serialise it back
   */
  constructor(read, write) {
    install();
    this.read = read;
    this.write = write;
    this.selection = null;
    this.drag = null;

    this.root = document.createElement("div");
    this.root.className = "mmd";
    this.root.innerHTML = `
      <div class="mmd-bar">
        ${TRACKS.map((t) => `<button data-add="${t.key}">+ ${t.noun}</button>`).join("")}
        <span class="mmd-grow"></span>
        <span class="mmd-len"></span>
      </div>
      <div class="mmd-stage">
        <div class="mmd-ruler"></div>
        ${TRACKS.map((t) => `<div class="mmd-track" data-track="${t.key}" data-label="${t.label}"></div>`).join("")}
      </div>
      <div class="mmd-edit"></div>`;

    this.stage = this.root.querySelector(".mmd-stage");
    this.ruler = this.root.querySelector(".mmd-ruler");
    this.panel = this.root.querySelector(".mmd-edit");
    this.readout = this.root.querySelector(".mmd-len");

    this.root.addEventListener("click", (event) => {
      const track = event.target.dataset?.add;
      if (!track) return;
      const timeline = this.read();
      this.selection = { track, index: add(timeline, track) };
      this.commit(timeline);
    });

    this.stage.addEventListener("pointerdown", (event) => this.grab(event));
    // Drag continues on the document so the pointer can leave the segment mid-gesture.
    document.addEventListener("pointermove", (event) => this.move(event));
    document.addEventListener("pointerup", () => { this.drag = null; });
  }

  commit(timeline) {
    this.write(timeline);
    this.render();
  }

  // -- geometry ------------------------------------------------------------

  scale(timeline) {
    const width = this.stage.clientWidth - 14;
    return Math.max(width, 1) / Math.max(length(timeline), 1);
  }

  // -- gestures ------------------------------------------------------------

  grab(event) {
    const node = event.target.closest(".mmd-seg");
    if (!node) {
      this.selection = null;
      this.render();
      return;
    }
    const track = node.parentElement.dataset.track;
    const index = Number(node.dataset.index);
    const timeline = this.read();
    const item = items(timeline, track)[index];
    const box = node.getBoundingClientRect();
    const offset = event.clientX - box.left;

    this.selection = { track, index };
    this.drag = {
      track, index,
      originX: event.clientX,
      scale: this.scale(timeline),
      start: item.start,
      length: item.length,
      mode: offset <= EDGE ? "start" : offset >= box.width - EDGE ? "end" : "body",
    };
    this.render();
  }

  move(event) {
    if (!this.drag) return;
    const frames = Math.round((event.clientX - this.drag.originX) / this.drag.scale);
    if (frames === 0) return;

    const timeline = this.read();
    const item = items(timeline, this.drag.track)[this.drag.index];
    if (!item) return;

    if (this.drag.mode === "body") {
      reshape(item, { start: this.drag.start + frames });
    } else if (this.drag.mode === "start") {
      const start = Math.min(this.drag.start + frames, this.drag.start + this.drag.length - 1);
      reshape(item, { start, length: this.drag.length - (start - this.drag.start) });
    } else {
      reshape(item, { length: this.drag.length + frames });
    }
    this.commit(timeline);
  }

  // -- rendering -----------------------------------------------------------

  render() {
    const timeline = this.read();
    const total = length(timeline);
    const scale = this.scale(timeline);

    this.readout.textContent =
      `${total} frames · ${formatSeconds(toSeconds(total))}s · ${total % 17 === 5 ? "valid" : "INVALID"}`;

    this.renderRuler(total, scale);

    for (const { key } of TRACKS) {
      const lane = this.stage.querySelector(`[data-track="${key}"]`);
      lane.innerHTML = "";
      items(timeline, key).forEach((item, index) => {
        lane.appendChild(this.segment(key, index, item, scale));
      });
    }

    this.renderPanel(timeline);
  }

  renderRuler(total, scale) {
    const seconds = Math.max(1, Math.ceil(toSeconds(total)));
    const step = seconds <= 12 ? 1 : Math.ceil(seconds / 12);
    let html = "";
    for (let second = 0; second <= seconds; second += step) {
      html += `<span style="left:${second * 24 * scale}px">${second}s</span>`;
    }
    this.ruler.innerHTML = html;
  }

  segment(track, index, item, scale) {
    const node = document.createElement("div");
    node.className = "mmd-seg";
    if (this.selection?.track === track && this.selection.index === index) {
      node.classList.add("sel");
    }
    node.dataset.index = index;
    node.style.left = `${item.start * scale}px`;
    node.style.width = `${Math.max(item.length * scale, 12)}px`;
    node.title = `${item.start}–${item.start + item.length} frames`;
    node.textContent = item.prompt?.trim() || item.camera || `${item.length}f`;
    node.innerHTML += '<div class="grip l"></div><div class="grip r"></div>';
    return node;
  }

  renderPanel(timeline) {
    if (!this.selection) {
      this.panel.innerHTML =
        `<textarea class="global" placeholder="Global style and scene — the constants of the whole clip">${
          escape_(timeline.global_prompt || "")}</textarea>
         <span class="mmd-hint" style="grid-column:1/-1">Select a segment to edit it, or drag its edges to retime.</span>`;
      this.panel.querySelector(".global").oninput = (event) => {
        const next = this.read();
        next.global_prompt = event.target.value;
        this.write(next);
      };
      return;
    }

    const { track, index } = this.selection;
    const item = items(timeline, track)[index];
    if (!item) {
      this.selection = null;
      return this.renderPanel(timeline);
    }

    const cameras = track === "cues" ? "" : `
      <label>camera
        <select class="camera">
          ${CAMERAS.map((name) =>
            `<option value="${name}"${name === (item.camera || "") ? " selected" : ""}>${name || "—"}</option>`
          ).join("")}
        </select>
      </label>`;

    this.panel.innerHTML = `
      <textarea class="prompt" placeholder="What happens in this segment">${escape_(item.prompt || "")}</textarea>
      <label>start <input class="start" type="number" min="0" value="${item.start}"></label>
      <label>frames <input class="len" type="number" min="1" value="${item.length}"></label>
      ${cameras}
      <button class="danger">delete</button>`;

    const patch = (change) => {
      const next = this.read();
      Object.assign(items(next, track)[index], change);
      this.write(next);
      this.render();
    };

    this.panel.querySelector(".prompt").oninput = (event) => {
      const next = this.read();
      items(next, track)[index].prompt = event.target.value;
      this.write(next);
      const node = this.stage.querySelector(`[data-track="${track}"] [data-index="${index}"]`);
      if (node) node.firstChild.textContent = event.target.value || `${item.length}f`;
    };
    this.panel.querySelector(".start").onchange = (e) => patch({ start: Math.max(0, +e.target.value) });
    this.panel.querySelector(".len").onchange = (e) => patch({ length: Math.max(1, +e.target.value) });
    this.panel.querySelector(".camera")?.addEventListener("change", (e) => patch({ camera: e.target.value }));
    this.panel.querySelector(".danger").onclick = () => {
      const next = this.read();
      remove(next, track, index);
      this.selection = null;
      this.commit(next);
    };
  }
}

function escape_(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
