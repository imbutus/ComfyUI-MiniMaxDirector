/**
 * The timeline editor: a DOM widget, not a canvas painting.
 *
 * A director needs to be big, to scroll, to hold text inputs and media thumbnails --
 * all of which the DOM gives for free and a canvas would have to reimplement badly.
 *
 * One rule keeps it honest: the JSON is the only state. Every edit writes it back
 * immediately, and every render reads it fresh. There is no second copy to fall out of
 * sync, and a graph saved without this extension still carries a complete timeline.
 */

import { install } from "./styles.js";
import * as media from "./media.js";
import {
  CAMERAS, TRACKS, TRACK_FOR_MEDIA, add, formatSeconds, items, length, remove,
  reshape, toSeconds, FPS,
} from "./model.js";

const EDGE = 7;
const ZOOM_STEP = 1.35;

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
    this.zoom = 1;
    this.playhead = 0;
    this.playing = null;

    this.root = document.createElement("div");
    this.root.className = "mmd";
    this.root.innerHTML = `
      <div class="mmd-bar">
        <button data-media="image">⬆ Add Image</button>
        <button data-add="shots">T Add Text</button>
        <button data-media="audio">♪ Add Audio</button>
        <button data-media="video">▭ Add Video</button>
        <button data-add="moves">⟲ Add Camera</button>
        <button class="danger" data-del="1">🗑 Delete</button>
        <span class="mmd-grow"></span>
        <span class="mmd-len"></span>
      </div>

      <div class="mmd-stage">
        <div class="mmd-labels">
          ${TRACKS.map((t) => `<div class="mmd-label" data-for="${t.key}">${t.label}</div>`).join("")}
        </div>
        <div class="mmd-scroll">
          <div class="mmd-canvas">
            <div class="mmd-ruler"></div>
            ${TRACKS.map((t) => `<div class="mmd-track" data-track="${t.key}"></div>`).join("")}
            <div class="mmd-playhead"></div>
          </div>
        </div>
      </div>

      <div class="mmd-transport">
        <button class="mmd-play">▶</button>
        <span class="mmd-clock">0.00s</span>
        <span class="mmd-range"></span>
        <input class="mmd-scrub" type="range" min="0" max="1000" value="0">
        <button data-zoom="out">−</button>
        <button data-zoom="fit">fit</button>
        <button data-zoom="in">+</button>
      </div>

      <div class="mmd-prompt">
        <label>SEGMENT PROMPT</label>
        <textarea class="mmd-seg-prompt" placeholder="Select a segment, then describe what happens in it"></textarea>
        <div class="mmd-seg-fields"></div>
      </div>

      <div class="mmd-prompt">
        <label>GLOBAL PROMPT</label>
        <textarea class="mmd-global" placeholder="Style and scene constants for the whole clip"></textarea>
      </div>`;

    this.stage = this.root.querySelector(".mmd-scroll");
    this.canvas = this.root.querySelector(".mmd-canvas");
    this.ruler = this.root.querySelector(".mmd-ruler");
    this.head = this.root.querySelector(".mmd-playhead");
    this.readout = this.root.querySelector(".mmd-len");
    this.clock = this.root.querySelector(".mmd-clock");
    this.range = this.root.querySelector(".mmd-range");
    this.scrub = this.root.querySelector(".mmd-scrub");
    this.segPrompt = this.root.querySelector(".mmd-seg-prompt");
    this.segFields = this.root.querySelector(".mmd-seg-fields");
    this.global = this.root.querySelector(".mmd-global");

    this.bind();
  }

  bind() {
    this.root.addEventListener("click", (event) => {
      const el = event.target.closest("button");
      if (!el) return;
      if (el.dataset.add) this.append(el.dataset.add);
      else if (el.dataset.media) this.attach(el.dataset.media);
      else if (el.dataset.del) this.deleteSelected();
      else if (el.dataset.zoom) this.setZoom(el.dataset.zoom);
      else if (el.classList.contains("mmd-play")) this.togglePlay();
    });

    this.canvas.addEventListener("pointerdown", (event) => this.grab(event));
    document.addEventListener("pointermove", (event) => this.move(event));
    document.addEventListener("pointerup", () => { this.drag = null; });

    this.scrub.addEventListener("input", () => {
      const total = length(this.read());
      this.playhead = (this.scrub.value / 1000) * total;
      this.renderPlayhead(total);
    });

    this.segPrompt.addEventListener("input", () => {
      if (!this.selection) return;
      const next = this.read();
      const item = items(next, this.selection.track)[this.selection.index];
      if (!item) return;
      item.prompt = this.segPrompt.value;
      this.write(next);
      this.refreshLabel(item);
    });

    this.global.addEventListener("input", () => {
      const next = this.read();
      next.global_prompt = this.global.value;
      this.write(next);
    });
  }

  commit(timeline) {
    this.write(timeline);
    this.render();
  }

  // -- actions -------------------------------------------------------------

  append(track) {
    const timeline = this.read();
    this.selection = { track, index: add(timeline, track) };
    this.commit(timeline);
  }

  async attach(kind) {
    const file = await media.pick(kind);
    if (!file) return;

    let record;
    try {
      record = await media.upload(kind, file);
    } catch (error) {
      console.error("[MiniMaxDirector]", error);
      return;
    }

    const track = TRACK_FOR_MEDIA[kind];
    const timeline = this.read();
    const target =
      this.selection?.track === track ? this.selection.index : add(timeline, track, 2);
    const item = items(timeline, track)[target];
    item.media = record;
    this.selection = { track, index: target };
    this.commit(timeline);
  }

  deleteSelected() {
    if (!this.selection) return;
    const timeline = this.read();
    remove(timeline, this.selection.track, this.selection.index);
    this.selection = null;
    this.commit(timeline);
  }

  setZoom(mode) {
    if (mode === "fit") this.zoom = 1;
    else this.zoom = Math.min(24, Math.max(1, this.zoom * (mode === "in" ? ZOOM_STEP : 1 / ZOOM_STEP)));
    this.render();
  }

  togglePlay() {
    const button = this.root.querySelector(".mmd-play");
    if (this.playing) {
      clearInterval(this.playing);
      this.playing = null;
      button.textContent = "▶";
      return;
    }
    button.textContent = "❚❚";
    const total = length(this.read());
    this.playing = setInterval(() => {
      this.playhead += FPS / 20;
      if (this.playhead >= total) this.playhead = 0;
      this.renderPlayhead(total);
    }, 50);
  }

  // -- geometry ------------------------------------------------------------

  width() {
    return Math.max(this.stage.clientWidth - 4, 200) * this.zoom;
  }

  scale(total) {
    return this.width() / Math.max(total, 1);
  }

  // -- gestures ------------------------------------------------------------

  grab(event) {
    const node = event.target.closest(".mmd-seg");
    const total = length(this.read());

    if (!node) {
      // Clicking bare track area moves the playhead there, like a video editor.
      const box = this.canvas.getBoundingClientRect();
      this.playhead = Math.max(0, Math.min(total, (event.clientX - box.left) / this.scale(total)));
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
      scale: this.scale(total),
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
    const scale = this.scale(total);

    this.canvas.style.width = `${this.width()}px`;
    this.readout.textContent =
      `${total} frames · ${formatSeconds(toSeconds(total))}s · ${total % 17 === 5 ? "valid" : "INVALID"}`;

    this.renderRuler(total, scale);

    for (const { key } of TRACKS) {
      const lane = this.canvas.querySelector(`[data-track="${key}"]`);
      lane.innerHTML = "";
      items(timeline, key).forEach((item, index) => {
        lane.appendChild(this.segment(key, index, item, scale));
      });
    }

    this.renderPlayhead(total);
    this.renderPanel(timeline);
  }

  renderRuler(total, scale) {
    const seconds = toSeconds(total);
    const perSecond = 24 * scale;
    const step = perSecond > 90 ? 0.5 : perSecond > 45 ? 1 : Math.ceil(60 / perSecond);

    let html = "";
    for (let at = 0; at <= seconds + 0.001; at += step) {
      const label = step < 1 ? at.toFixed(2) : String(Math.round(at));
      html += `<span style="left:${at * perSecond}px">${label}</span>`;
    }
    this.ruler.innerHTML = html;
  }

  renderPlayhead(total) {
    const scale = this.scale(total);
    this.head.style.left = `${this.playhead * scale}px`;
    this.clock.textContent = `${toSeconds(this.playhead).toFixed(2)}s`;
    this.scrub.value = String(Math.round((this.playhead / Math.max(total, 1)) * 1000));
  }

  segment(track, index, item, scale) {
    const node = document.createElement("div");
    node.className = "mmd-seg";
    if (this.selection?.track === track && this.selection.index === index) {
      node.classList.add("sel");
    }
    node.dataset.index = index;
    node.style.left = `${item.start * scale}px`;
    node.style.width = `${Math.max(item.length * scale, 14)}px`;

    if (item.media) media.decorate(node, item.media);

    const caption = document.createElement("span");
    caption.className = "cap";
    caption.textContent = item.prompt?.trim() || item.camera || "";
    node.appendChild(caption);

    if (item.media?.filename) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = `${item.media.kind.toUpperCase()} · ${item.media.filename}`;
      node.appendChild(chip);
    }

    node.insertAdjacentHTML("beforeend", '<div class="grip l"></div><div class="grip r"></div>');
    return node;
  }

  refreshLabel(item) {
    const node = this.canvas.querySelector(
      `[data-track="${this.selection.track}"] [data-index="${this.selection.index}"] .cap`);
    if (node) node.textContent = item.prompt?.trim() || item.camera || "";
  }

  renderPanel(timeline) {
    this.global.value = timeline.global_prompt || "";

    if (!this.selection) {
      this.segPrompt.value = "";
      this.segPrompt.disabled = true;
      this.segFields.innerHTML = "";
      this.range.textContent = "no segment selected";
      return;
    }

    const { track, index } = this.selection;
    const item = items(timeline, track)[index];
    if (!item) {
      this.selection = null;
      return this.renderPanel(timeline);
    }

    this.segPrompt.disabled = false;
    if (document.activeElement !== this.segPrompt) this.segPrompt.value = item.prompt || "";

    this.range.textContent =
      `Start: ${toSeconds(item.start).toFixed(2)} | End: ${toSeconds(item.end ?? item.start + item.length).toFixed(2)}` +
      ` | Length: ${toSeconds(item.length).toFixed(2)}`;

    const cameras = track === "cues" ? "" : `
      <label>camera
        <select class="camera">
          ${CAMERAS.map((name) =>
            `<option value="${name}"${name === (item.camera || "") ? " selected" : ""}>${name || "—"}</option>`
          ).join("")}
        </select>
      </label>`;

    this.segFields.innerHTML = `
      <label>start <input class="start" type="number" min="0" value="${item.start}"></label>
      <label>frames <input class="len" type="number" min="1" value="${item.length}"></label>
      ${cameras}
      ${item.media ? '<button class="unlink">detach media</button>' : ""}`;

    const patch = (change) => {
      const next = this.read();
      Object.assign(items(next, track)[index], change);
      this.commit(next);
    };

    this.segFields.querySelector(".start").onchange = (e) => patch({ start: Math.max(0, +e.target.value) });
    this.segFields.querySelector(".len").onchange = (e) => patch({ length: Math.max(1, +e.target.value) });
    this.segFields.querySelector(".camera")?.addEventListener("change", (e) => patch({ camera: e.target.value }));
    this.segFields.querySelector(".unlink")?.addEventListener("click", () => {
      const next = this.read();
      delete items(next, track)[index].media;
      this.commit(next);
    });
  }
}
