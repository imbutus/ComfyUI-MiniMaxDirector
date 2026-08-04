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
const HISTORY_LIMIT = 100;
const TYPING_PAUSE = 500;

/** The dragged track as it was when the gesture started. */
function restoreDragged(timeline, drag) {
  return timeline[drag.track].map((item, index) =>
    index === drag.index ? { ...item, start: drag.start, length: drag.length } : item);
}

export class TimelineEditor {
  /**
   * @param {() => object} read   parse the JSON widget
   * @param {(t: object) => void} write  serialise it back
   * @param {object} widgets  the node's own width/height/ref_image_size widgets, which
   *   this editor renders compactly instead of letting them span the node
   */
  constructor(read, write, widgets = {}) {
    install();
    this.read = read;
    this.write = write;
    this.widgets = widgets;
    this.selection = null;
    this.drag = null;
    this.zoom = 1;
    this.playhead = 0;
    this.playing = null;

    // Undo state. Snapshots are JSON strings of the whole document -- small, trivially
    // comparable, and immune to any aliasing bug a structural copy could introduce.
    this.history = [];
    this.future = [];
    this.typing = null;
    this.active = false;

    this.root = document.createElement("div");
    this.root.className = "mmd";
    // Focusable so Delete can be handled here and kept away from ComfyUI, which binds
    // the same key to "remove the selected node".
    this.root.tabIndex = 0;
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

      <div class="mmd-settings"></div>

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

    this.settings = this.root.querySelector(".mmd-settings");
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

    // Delete / Backspace remove the selected segment.
    //
    // This has to listen on the document in the capture phase. Clicking a segment does
    // not leave focus inside the widget -- LiteGraph pulls it straight back to <body> --
    // so a listener on our own element never fires. Capture also puts us ahead of
    // ComfyUI's handler, which binds the same key to "delete the selected node": without
    // stopping the event, deleting a shot would delete the whole Director.
    //
    // Having a selection is what scopes it. Clicking anywhere outside clears that below,
    // so we never swallow a Delete meant for the graph.
    document.addEventListener("keydown", (event) => {
      // Fields keep their native text undo and character deletion.
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;

      // Cmd+Z on macOS, Ctrl+Z elsewhere; Shift (or Ctrl+Y) redoes. Scoped to the
      // editor having been touched last, so ComfyUI keeps its own graph undo.
      const chord = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (this.active && chord && (key === "z" || key === "y")) {
        event.preventDefault();
        event.stopPropagation();
        if (key === "y" || event.shiftKey) this.redo();
        else this.undo();
        return;
      }

      if (!this.selection) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        event.stopPropagation();
        this.deleteSelected();
      } else if (event.key === "Escape") {
        event.stopPropagation();
        this.selection = null;
        this.applySelection();
      }
    }, true);

    // A click outside the editor gives the keyboard back to ComfyUI.
    document.addEventListener("pointerdown", (event) => {
      this.active = this.root.contains(event.target);
      if (!this.active && this.selection) {
        this.selection = null;
        this.applySelection();
      }
    }, true);

    this.canvas.addEventListener("pointerdown", (event) => this.grab(event));
    this.canvas.addEventListener("dblclick", (event) => this.editInPlace(event));
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
      this.snapshotTyping();
      item.prompt = this.segPrompt.value;
      this.write(next);
      this.refreshLabel(item);
    });

    this.global.addEventListener("input", () => {
      this.snapshotTyping();
      const next = this.read();
      next.global_prompt = this.global.value;
      this.write(next);
    });
  }

  commit(timeline) {
    this.snapshot();
    this.write(timeline);
    this.render();
  }

  /**
   * Record the document as it stands, before a change is written.
   *
   * Called ahead of every mutation, so the stack holds states the user actually saw.
   * A new action clears the redo branch, which is what every editor does.
   */
  snapshot() {
    const current = JSON.stringify(this.read());
    if (this.history[this.history.length - 1] === current) return;
    this.history.push(current);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future.length = 0;
  }

  /**
   * Snapshot once per burst of typing.
   *
   * Text is written through on every keystroke so the tracks stay live, but one undo
   * step per character would be useless. The first keystroke of a burst records the
   * state before it; the rest ride along until the typist pauses.
   */
  snapshotTyping() {
    if (!this.typing) this.snapshot();
    clearTimeout(this.typing);
    this.typing = setTimeout(() => { this.typing = null; }, TYPING_PAUSE);
  }

  undo() {
    if (!this.history.length) return;
    this.future.push(JSON.stringify(this.read()));
    this.restore(this.history.pop());
  }

  redo() {
    if (!this.future.length) return;
    this.history.push(JSON.stringify(this.read()));
    this.restore(this.future.pop());
  }

  restore(json) {
    this.typing = null;
    this.selection = null;
    this.write(JSON.parse(json));
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
    // An open inline editor owns its own clicks; starting a drag would close it.
    if (event.target.classList.contains("mmd-inline")) return;

    const node = event.target.closest(".mmd-seg");
    const total = length(this.read());

    if (!node) {
      // Clicking bare track area moves the playhead there, like a video editor.
      const box = this.canvas.getBoundingClientRect();
      this.playhead = Math.max(0, Math.min(total, (event.clientX - box.left) / this.scale(total)));
      this.selection = null;
      this.renderPlayhead(total);
      this.applySelection();
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
    this.applySelection();
  }

  /**
   * Update the selection without rebuilding the track DOM.
   *
   * A full render on pointerdown replaces every segment element, so the second click of
   * a double-click lands on a node that did not receive the first one and the dblclick
   * event never reaches the segment. Selection is a class toggle; only document changes
   * justify a re-render.
   */
  applySelection() {
    for (const node of this.canvas.querySelectorAll(".mmd-seg.sel")) {
      node.classList.remove("sel");
    }
    if (this.selection) {
      this.canvas
        .querySelector(`[data-track="${this.selection.track}"] [data-index="${this.selection.index}"]`)
        ?.classList.add("sel");
    }
    this.renderPanel(this.read());
  }

  /**
   * Double-click a segment to write in it.
   *
   * The prompt box below works, but reads like a form. Editing where the text already
   * is keeps attention on the timeline, which is where the shape of the clip lives.
   */
  editInPlace(event) {
    const node = event.target.closest(".mmd-seg");
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();

    const track = node.parentElement.dataset.track;
    const index = Number(node.dataset.index);
    const item = items(this.read(), track)[index];
    if (!item) return;

    this.selection = { track, index };
    node.querySelector(".mmd-inline")?.remove();

    const box = document.createElement("textarea");
    box.className = "mmd-inline";
    box.value = item.prompt || "";
    node.appendChild(box);
    box.focus();
    box.select();

    const save = () => {
      const next = this.read();
      const target = items(next, track)[index];
      if (target) target.prompt = box.value;
      box.remove();
      this.commit(next);
    };

    box.addEventListener("input", () => {
      this.snapshotTyping();
      const next = this.read();
      const target = items(next, track)[index];
      if (!target) return;
      target.prompt = box.value;
      this.write(next);
      this.segPrompt.value = box.value;
    });
    box.addEventListener("blur", save);
    box.addEventListener("keydown", (key) => {
      key.stopPropagation();
      // Enter commits, Shift+Enter keeps the newline. Escape also commits, because the
      // text was already written through on every keystroke -- nothing to roll back to.
      if ((key.key === "Enter" && !key.shiftKey) || key.key === "Escape") {
        key.preventDefault();
        box.blur();
      }
    });
  }

  move(event) {
    if (!this.drag) return;
    const frames = Math.round((event.clientX - this.drag.originX) / this.drag.scale);
    if (frames === 0) return;

    const timeline = this.read();
    const item = items(timeline, this.drag.track)[this.drag.index];
    if (!item) return;

    if (!this.drag.recorded) {
      // The gesture's whole travel is one step: snapshot the state it began from.
      this.history.push(JSON.stringify({ ...timeline, [this.drag.track]: restoreDragged(timeline, this.drag) }));
      this.future.length = 0;
      this.drag.recorded = true;
    }

    if (this.drag.mode === "body") {
      reshape(item, { start: this.drag.start + frames });
    } else if (this.drag.mode === "start") {
      const start = Math.min(this.drag.start + frames, this.drag.start + this.drag.length - 1);
      reshape(item, { start, length: this.drag.length - (start - this.drag.start) });
    } else {
      reshape(item, { length: this.drag.length + frames });
    }
    this.write(timeline);
    this.render();
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
    this.renderSettings(timeline);
  }

  /**
   * The clip-level settings, in one compact row.
   *
   * ComfyUI gives every widget the full width of the node. At 1380px that turns four
   * short numbers into four near-empty bars, so `width`, `height` and `ref_image_size`
   * are hidden on the node and mirrored here. Writing back to the same widget objects
   * keeps the node the single source of truth -- the graph still serialises normally.
   */
  renderSettings(timeline) {
    const value = (name) => this.widgets[name]?.value;
    const secs = (frames) => toSeconds(frames || 0).toFixed(2);

    this.settings.innerHTML = `
      <label>start <input class="s-start" type="number" min="0" step="0.1" value="${secs(timeline.start)}"><span class="unit">s</span></label>
      <label>end <input class="s-end" type="number" min="0" step="0.1" value="${secs(timeline.end)}"><span class="unit">s</span></label>
      <label>duration <input class="s-duration" type="number" min="0" step="0.1" value="${secs(timeline.duration)}"><span class="unit">s</span></label>
      <label>frame rate <span class="fixed">${FPS}</span><span class="unit">fps</span></label>
      <label>width <input class="s-width" type="number" min="32" step="32" value="${value("width") ?? 1344}"></label>
      <label>height <input class="s-height" type="number" min="32" step="32" value="${value("height") ?? 768}"></label>
      <label>resize
        <select class="s-ref">
          ${["match", "max"].map((o) =>
            `<option value="${o}"${o === value("ref_image_size") ? " selected" : ""}>${o}</option>`).join("")}
        </select>
      </label>
      <label>dialect
        <select class="s-dialect">
          ${["timeline", "shots"].map((o) =>
            `<option value="${o}"${o === (timeline.dialect || "timeline") ? " selected" : ""}>${o}</option>`).join("")}
        </select>
      </label>
      <span class="mmd-grow"></span>
      <span class="hint">0 = auto · end 0 = to the end</span>`;

    const setWidget = (name, raw) => {
      const widget = this.widgets[name];
      if (!widget) return;
      widget.value = raw;
      widget.callback?.(raw);
    };

    const setFrames = (field, key) => {
      this.settings.querySelector(field).onchange = (e) => {
        const next = this.read();
        next[key] = Math.max(0, Math.round(Number(e.target.value) * FPS));
        this.commit(next);
      };
    };
    setFrames(".s-duration", "duration");
    setFrames(".s-start", "start");
    setFrames(".s-end", "end");
    this.settings.querySelector(".s-width").onchange = (e) => setWidget("width", Math.max(32, +e.target.value));
    this.settings.querySelector(".s-height").onchange = (e) => setWidget("height", Math.max(32, +e.target.value));
    this.settings.querySelector(".s-ref").onchange = (e) => setWidget("ref_image_size", e.target.value);
    this.settings.querySelector(".s-dialect").onchange = (e) => {
      const next = this.read();
      next.dialect = e.target.value;
      this.commit(next);
    };
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
