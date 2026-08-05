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

import { BUILD } from "../build.js";
import { install } from "./styles.js";
import * as media from "./media.js";
import {
  CAMERAS, TRACKS, TRACK_FOR_MEDIA, add, bounds, ceiling, formatSeconds, items, length,
  neighbours,
  remove, reshape, span, toSeconds, FPS,
} from "./model.js";

/**
 * Toolbar icons as inline SVG.
 *
 * Emoji were the obvious shortcut and the wrong one: a colour emoji renders at the
 * mercy of whatever font the host has, and the wastebasket in particular came out as a
 * mismatched blob. These are strokes in `currentColor`, so they match the button text
 * on any platform and inherit hover and disabled states for free.
 */
const svg = (body) =>
  `<svg class="mmd-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor"` +
  ` stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICON = {
  image: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1"/><path d="M2.6 12l3.4-3.6 2.4 2.3 2-1.9 3 3.2"/>'),
  text: svg('<path d="M3 4h10M8 4v9M6 13h4"/>'),
  audio: svg('<path d="M6 12V4l7-1.4v8"/><circle cx="4.4" cy="12" r="1.7"/><circle cx="11.4" cy="10.6" r="1.7"/>'),
  video: svg('<rect x="2" y="4" width="8.5" height="8" rx="1.2"/><path d="M10.5 7.4L14 5.4v5.2l-3.5-2z"/>'),
  camera: svg('<circle cx="8" cy="8" r="4.6"/><path d="M8 3.4V1.8M12.6 8h1.6"/><circle cx="8" cy="8" r="1.4"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 001 .8h3.8a1 1 0 001-.8l.6-8.2M7 7v4M9 7v4"/>'),
  sound: svg('<path d="M1.5 8h2l2-4.5 2 9 2-7 1.5 2.5h2"/>'),
};

/** Anything a keystroke could legitimately be typed into. */
const isEditable = (el) =>
  !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

const ZOOM_STEP = 1.35;
const HISTORY_LIMIT = 100;
/** One lattice step, in seconds, used as the inputs' `step`.
 *
 * `min` has to be the first legal length rather than zero: a browser steps from `min`,
 * and legal lengths are 17n+**5** frames. Basing the step at zero walks 17-frame
 * multiples that all miss the grid by five, so every arrow press would need correcting.
 */
const STEP = (17 / 24).toFixed(4);
const BASE = (5 / 24).toFixed(4);
const TAIL = 34;
const TYPING_PAUSE = 500;


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
    this.selected = [];
    this.drag = null;
    this.panelShape = null;
    this.marquee = null;
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
        <button data-add="shots" title="Describe what happens over a span -- no file needed">${ICON.text} Add Video Prompt</button>
        <button data-add="cues" title="Describe a sound over a span -- H3 generates it, no file needed">${ICON.sound} Add Sound Prompt</button>
        <button data-add="moves" title="A camera move over a span, from the vocabulary plus a note -- no file needed">${ICON.camera} Add Camera Prompt</button>
        <button data-media="image">${ICON.image} Add Image</button>
        <button data-media="audio">${ICON.audio} Add Audio</button>
        <button data-media="video">${ICON.video} Add Video</button>
        <button class="mmd-danger" data-del="1">${ICON.trash} Delete</button>
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
            <div class="mmd-end"></div>
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
      </div>

      <div class="mmd-prompt">
        <label title="non_diegetic_music: score only the audience hears. Instrumentation, tempo and dynamics -- not mood words. Left empty it compiles to N/A.">MUSIC (audience only)</label>
        <textarea class="mmd-music" placeholder="Sparse piano notes at a slow tempo, joined by low strings that fade out"></textarea>
      </div>`;

    this.settings = this.root.querySelector(".mmd-settings");
    this.stage = this.root.querySelector(".mmd-scroll");
    this.canvas = this.root.querySelector(".mmd-canvas");
    this.ruler = this.root.querySelector(".mmd-ruler");
    this.head = this.root.querySelector(".mmd-playhead");
    this.end = this.root.querySelector(".mmd-end");
    this.readout = this.root.querySelector(".mmd-len");
    this.clock = this.root.querySelector(".mmd-clock");
    this.range = this.root.querySelector(".mmd-range");
    this.scrub = this.root.querySelector(".mmd-scrub");
    this.segPrompt = this.root.querySelector(".mmd-seg-prompt");
    this.segFields = this.root.querySelector(".mmd-seg-fields");
    this.global = this.root.querySelector(".mmd-global");
    this.music = this.root.querySelector(".mmd-music");

    this.bind();
  }

  /**
   * The single selected segment, or null when zero or many are selected.
   *
   * Most of the editor cares about "the one being edited", while marquee selection
   * needs a list. Keeping this pair means the panel, the inline editor and the drag
   * code stay written in terms of one segment.
   */
  get selection() {
    return this.selected.length === 1 ? this.selected[0] : null;
  }

  set selection(value) {
    this.selected = value ? [value] : [];
  }

  isSelected(track, index) {
    return this.selected.some((s) => s.track === track && s.index === index);
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
      // Fields keep their native text undo and character deletion. Both the event's
      // target and whatever actually holds focus are checked: a keystroke aimed at a
      // field can be reported against an ancestor, and one Delete swallowed here is a
      // deleted block instead of a deleted character.
      if (isEditable(event.target) || isEditable(document.activeElement)) return;

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

      if (!this.selected.length) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        event.stopPropagation();
        this.deleteSelected();
      } else if (event.key === "Escape") {
        event.stopPropagation();
        this.selected = [];
        this.applySelection();
      }
    }, true);

    // A click outside the editor gives the keyboard back to ComfyUI.
    document.addEventListener("pointerdown", (event) => {
      this.active = this.root.contains(event.target);
      if (!this.active && this.selected.length) {
        this.selected = [];
        this.applySelection();
      }
    }, true);

    this.canvas.addEventListener("pointerdown", (event) => this.grab(event));
    this.canvas.addEventListener("dblclick", (event) => this.editInPlace(event));
    document.addEventListener("pointermove", (event) => this.move(event));
    document.addEventListener("pointerup", () => {
      this.drag = null;
      if (this.marquee) this.endMarquee();
    });

    this.scrub.addEventListener("input", () => {
      const extent = this.extent();
      this.playhead = (this.scrub.value / 1000) * extent;
      this.renderPlayhead(extent);
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

    this.music.addEventListener("input", () => {
      this.snapshotTyping();
      const next = this.read();
      next.music = this.music.value;
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
    const firstImage = kind === "image"
      && !items(timeline, track).some((entry) => entry.media?.kind === "image");
    // Always a new segment, never a swap. Dropping the file onto whatever happened to
    // be selected silently destroyed the media already there -- and "add" should add.
    const target = add(timeline, track, 2);
    const item = items(timeline, track)[target];
    item.media = record;
    this.selection = { track, index: target };
    this.commit(timeline);

    // The first reference image sets the generation size, but only under "match" --
    // that mode scales references to the generation's pixel area, so a mismatched
    // aspect ratio is squandered on letterboxing. Under "max" the reference keeps its
    // own resolution and the generation size is an independent decision.
    if (firstImage && this.widgets.ref_image_size?.value === "match") {
      const size = await media.dimensions(record);
      if (size) this.adoptSize(media.fitGeneration(size));
    }
  }

  /** Point the node's width/height widgets at a size, and show it. */
  adoptSize({ width, height }) {
    for (const [name, value] of [["width", width], ["height", height]]) {
      const widget = this.widgets[name];
      if (!widget) continue;
      widget.value = value;
      widget.callback?.(value);
    }
    this.render();
  }

  deleteSelected() {
    if (!this.selected.length) return;
    const timeline = this.read();
    // Highest index first, so earlier removals cannot shift the ones still to come.
    for (const { track, index } of [...this.selected].sort((a, b) => b.index - a.index)) {
      remove(timeline, track, index);
    }
    this.selected = [];
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
    const total = this.extent();
    this.playing = setInterval(() => {
      this.playhead += FPS / 20;
      if (this.playhead >= total) this.playhead = 0;
      this.renderPlayhead(total);
    }, 50);
  }

  // -- geometry ------------------------------------------------------------

  /**
   * How much the graph is zoomed, as seen by this widget.
   *
   * ComfyUI renders DOM widgets inside a CSS-transformed container, so
   * `getBoundingClientRect` returns *screen* pixels while `style.left` is written in
   * the element's own unscaled pixels. Mixing the two puts everything off by the zoom
   * factor -- a marquee drawn up and to the left of the pointer, drags that move the
   * wrong distance.
   */
  factor() {
    const rect = this.canvas.getBoundingClientRect();
    const width = this.canvas.offsetWidth;
    return rect.width > 0 && width > 0 ? rect.width / width : 1;
  }

  /** A client point in the canvas's own coordinates. */
  toLocal(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const factor = this.factor();
    return [(clientX - rect.left) / factor, (clientY - rect.top) / factor];
  }

  /**
   * Pixels the clip itself occupies.
   *
   * A tail of empty space is left past the end so the final boundary is visible rather
   * than flush against the edge of the viewport -- at fit zoom the last segment used to
   * end exactly on the border, which reads as "cut off" instead of "finished".
   */
  width() {
    return Math.max(this.stage.clientWidth - TAIL, 200) * this.zoom;
  }

  /** Pixels per frame across the whole piece, not just the window.
   *  The tracks show everything you have edited; the window is drawn on top of it.
   *
   *  A gesture in progress keeps the scale it started with. The drag maths are fixed at
   *  pointerdown, and with no explicit duration the extent follows the content -- so
   *  resizing the last segment would otherwise shrink the extent, grow the scale, and
   *  slide the edge out from under the cursor as you drag it. */
  scale() {
    if (this.drag) return this.drag.scale;
    return this.width() / Math.max(this.extent(), 1);
  }

  /** Frames the view covers: the clip, or the content if it runs past it. */
  extent() {
    const timeline = this.read();
    return Math.max(length(timeline), span(timeline), 1);
  }

  // -- gestures ------------------------------------------------------------

  grab(event) {
    // An open inline editor owns its own clicks; starting a drag would close it.
    if (event.target.classList.contains("mmd-inline")) return;

    const node = event.target.closest(".mmd-seg");
    const total = this.extent();

    if (!node) {
      // Empty space starts a marquee. If the pointer never moves it is just a click,
      // and `endMarquee` falls back to placing the playhead there.
      this.marquee = {
        x0: event.clientX, y0: event.clientY,
        additive: event.shiftKey || event.metaKey || event.ctrlKey,
        base: event.shiftKey || event.metaKey || event.ctrlKey ? [...this.selected] : [],
        moved: false,
      };
      this.box = document.createElement("div");
      this.box.className = "mmd-marquee";
      this.canvas.appendChild(this.box);
      return;
    }

    const track = node.parentElement.dataset.track;
    const index = Number(node.dataset.index);
    const timeline = this.read();
    const item = items(timeline, track)[index];

    // Grabbing something already in a multi-selection keeps the group and moves it
    // together; grabbing anything else selects just that one.
    if (!this.isSelected(track, index)) {
      if (event.shiftKey || event.metaKey || event.ctrlKey) this.selected.push({ track, index });
      else this.selected = [{ track, index }];
    }

    // What the pointer is actually over decides the gesture -- the same element the
    // cursor style comes from. Measuring an offset instead let the two disagree: the
    // offset is in the widget's own pixels while `box.width` is screen pixels, and the
    // graph's zoom sits between them, so the resize zone drifted with the zoom level.
    const grip = event.target.closest(".mmd-grip");
    const mode = grip
      ? (grip.classList.contains("mmd-l") ? "start" : "end")
      : "body";
    this.drag = {
      track, index, mode,
      originX: event.clientX,
      scale: this.scale(),
      start: item.start,
      length: item.length,
      // Resizing only ever applies to the grabbed segment; moving applies to the group.
      group: mode === "body"
        ? this.selected.map(({ track: t, index: i }) => {
            const entry = items(timeline, t)[i];
            const kin = this.selected.filter((o) => o.track === t).map((o) => o.index);
            return {
              track: t, index: i, start: entry.start, length: entry.length,
              limits: bounds(timeline, t, i, kin),
            };
          })
        : [],
      // Neighbours are read once, at the start of the gesture, so they cannot shift
      // underneath a drag that is still in progress.
      limits: bounds(timeline, track, index),
      baseline: JSON.stringify(timeline),
      recorded: false,
    };
    this.applySelection();
  }

  /**
   * Finish a rubber-band drag: select everything the rectangle touched.
   *
   * A rectangle that never moved is treated as a plain click -- deselect, and put the
   * playhead where the pointer went down.
   */
  endMarquee() {
    const rect = this.box.getBoundingClientRect();
    const moved = this.marquee.moved;
    const additive = this.marquee.additive;
    const base = this.marquee.base;
    this.marqueeOrigin = [this.marquee.x0, this.marquee.y0];

    this.box.remove();
    this.box = null;
    this.marquee = null;

    if (!moved) {
      const total = this.extent();
      const [x] = this.toLocal(this.marqueeOrigin[0], this.marqueeOrigin[1]);
      this.playhead = Math.max(0, Math.min(total, x / this.scale()));
      this.selected = [];
      this.renderPlayhead(total);
      this.applySelection();
      return;
    }

    this.selected = this.hitsIn(rect, additive ? base : []);
    this.applySelection();
  }

  /**
   * Every segment the rectangle touches, on top of `base`.
   *
   * Both rectangles come from `getBoundingClientRect`, so this compares screen space to
   * screen space and needs no zoom correction.
   */
  hitsIn(rect, base) {
    const hits = [...base];
    for (const node of this.canvas.querySelectorAll(".mmd-seg")) {
      const seg = node.getBoundingClientRect();
      const overlaps = seg.left < rect.right && rect.left < seg.right
                    && seg.top < rect.bottom && rect.top < seg.bottom;
      if (!overlaps) continue;
      const track = node.parentElement.dataset.track;
      const index = Number(node.dataset.index);
      if (!hits.some((h) => h.track === track && h.index === index)) hits.push({ track, index });
    }
    return hits;
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
    this.markSelection();
    this.renderPanel(this.read());
  }

  /** Just the highlight. Cheap enough to run on every pointer move. */
  markSelection() {
    for (const node of this.canvas.querySelectorAll(".mmd-seg.mmd-sel")) {
      node.classList.remove("mmd-sel");
    }
    for (const { track, index } of this.selected) {
      this.canvas
        .querySelector(`[data-track="${track}"] [data-index="${index}"]`)
        ?.classList.add("mmd-sel");
    }
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
    if (this.marquee) {
      const [ax, ay] = this.toLocal(this.marquee.x0, this.marquee.y0);
      const [bx, by] = this.toLocal(event.clientX, event.clientY);
      const x = Math.min(ax, bx);
      const y = Math.min(ay, by);
      const w = Math.abs(bx - ax);
      const h = Math.abs(by - ay);
      if (w > 3 || h > 3) this.marquee.moved = true;
      Object.assign(this.box.style, {
        left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`,
      });

      // Selection follows the rectangle live: segments light up as it covers them and
      // go dark again as it leaves. Waiting for mouseup means dragging blind.
      this.selected = this.hitsIn(this.box.getBoundingClientRect(), this.marquee.base);
      this.markSelection();
      this.range.textContent = this.selected.length
        ? `${this.selected.length} selected`
        : "nothing in the box yet";
      return;
    }

    if (!this.drag) return;
    const frames = Math.round(
      ((event.clientX - this.drag.originX) / this.factor()) / this.drag.scale);
    if (frames === 0) return;

    const timeline = this.read();
    const item = items(timeline, this.drag.track)[this.drag.index];
    if (!item) return;

    if (!this.drag.recorded) {
      // The gesture's whole travel is one undo step: record the state it began from.
      this.history.push(this.drag.baseline);
      this.future.length = 0;
      this.drag.recorded = true;
    }

    // Blocks may not overlap: a segment describes what happens over a span of frames,
    // and two descriptions of the same frames is not something the prompt can express.
    if (this.drag.mode === "body") {
      let lowest = -Infinity;
      let highest = Infinity;
      for (const member of this.drag.group) {
        lowest = Math.max(lowest, member.limits[0] - member.start);
        highest = Math.min(highest, member.limits[1] - (member.start + member.length));
      }
      const shift = Math.max(lowest, Math.min(highest, frames));
      for (const member of this.drag.group) {
        reshape(items(timeline, member.track)[member.index], { start: member.start + shift });
      }
    } else if (this.drag.mode === "start") {
      const finish = this.drag.start + this.drag.length;
      const start = Math.min(
        Math.max(this.drag.start + frames, this.drag.limits[0]), finish - 1);
      reshape(item, { start, length: finish - start });
    } else {
      const room = this.drag.limits[1] - this.drag.start;
      reshape(item, { length: Math.max(1, Math.min(this.drag.length + frames, room)) });
    }
    this.write(timeline);
    this.render();
  }

  // -- rendering -----------------------------------------------------------

  /**
   * Put the caret back where it was.
   *
   * Writing the document makes ComfyUI redraw the node, and that pulls focus out to the
   * canvas -- mid-word, with no warning. The visible damage is not the lost caret: it is
   * that the next Delete is no longer aimed at a field, so the document-level handler
   * takes it and removes a block instead of a character.
   */
  keepFocus(run) {
    const el = document.activeElement;
    if (!(isEditable(el) && this.root.contains(el))) return run();

    let range = null;
    try { range = [el.selectionStart, el.selectionEnd]; } catch { /* number inputs */ }
    run();

    const restore = () => {
      if (document.activeElement === el || !this.root.contains(el)) return;
      el.focus();
      if (range && range[0] !== null) {
        try { el.setSelectionRange(range[0], range[1]); } catch { /* not selectable */ }
      }
    };
    restore();
    // ComfyUI may take the focus back a frame later, once it redraws the node.
    requestAnimationFrame(restore);
  }

  render() {
    if (!this.rendering) {
      this.rendering = true;
      try { return this.keepFocus(() => this.render()); }
      finally { this.rendering = false; }
    }
    const timeline = this.read();
    const extent = this.extent();
    const rendered = length(timeline);
    const scale = this.scale();
    this.canvas.style.width = `${this.width() + TAIL}px`;
    this.end.style.left = `${extent * scale}px`;
    this.readout.textContent =
      `${rendered} frames · ${formatSeconds(toSeconds(rendered))}s · ` +
      `${rendered % 17 === 5 ? "valid" : "INVALID"}`;

    this.renderRuler(extent, scale);

    for (const { key } of TRACKS) {
      const lane = this.canvas.querySelector(`[data-track="${key}"]`);
      lane.innerHTML = "";
      items(timeline, key).forEach((item, index) => {
        lane.appendChild(this.segment(key, index, item, scale));
      });
    }

    this.renderPlayhead(extent);
    this.renderPanel(timeline);
    this.renderSettings(timeline);
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
    const scale = this.scale();
    this.head.style.left = `${this.playhead * scale}px`;
    this.clock.textContent = `${toSeconds(this.playhead).toFixed(2)}s`;
    this.scrub.value = String(Math.round((this.playhead / Math.max(total, 1)) * 1000));
  }

  /**
   * What the last edit did, in words.
   *
   * H3 only accepts lengths on the 17-frame grid, so a typed duration is rounded up.
   * Without saying so, entering 5s and getting 5.17s back reads as the field refusing
   * to save -- the number typed and the number shown differ for a reason the UI never
   * mentioned.
   */
  snapNote(timeline) {
    const actual = length(timeline);
    if (this.asked && this.asked.frames && this.asked.frames !== actual) {
      return `${(this.asked.frames / FPS).toFixed(2)}s → ${(actual / FPS).toFixed(2)}s ·`
           + ` rounded up to ${actual} frames (17n+5)`;
    }
    return timeline.duration
      ? `${actual} frames · fixed`
      : `${actual} frames · following the content`;
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
    const rendered = length(timeline);
    const secs = (frames) => toSeconds(frames || 0).toFixed(2);
    const widget = (name) => this.widgets[name]?.value;

    if (!this.settings.firstChild) this.buildSettings();

    // Values are written into the existing controls rather than re-rendered. Rebuilding
    // the markup on every commit destroyed whatever was being typed and threw away the
    // caret -- a field would silently revert to the stored value mid-edit.
    const set = (selector, value) => {
      const node = this.settings.querySelector(selector);
      if (node && node !== document.activeElement) node.value = value;
    };
    set(".s-duration", secs(timeline.duration || rendered));
    set(".s-width", widget("width") ?? 1344);
    set(".s-height", widget("height") ?? 768);
    set(".s-ref", widget("ref_image_size") ?? "match");
    set(".s-dialect", timeline.dialect || "official");

    // The lattice appears here and nowhere else. A typed duration is left alone; this
    // says what will actually be generated, which is where the 17-frame grid bites.
    const asked = timeline.duration || span(timeline);
    this.settings.querySelector(".mmd-renders").textContent =
      `renders ${rendered} frames · ${(rendered / FPS).toFixed(2)}s` +
      (rendered !== asked ? ` (${asked}f rounded up)` : "");
  }

  /** The settings row, built once. */
  buildSettings() {
    this.settings.innerHTML = `
      <label title="Length of the whole piece"><span class="mmd-key">duration</span><input class="s-duration" type="number" min="0" step="0.1"><span class="mmd-unit">s</span></label>
      <label title="MiniMax H3 always generates at 24 fps -- the model has no other rate"><span class="mmd-key">frame rate</span><span class="mmd-value">${FPS}</span><span class="mmd-unit">fps · fixed</span></label>
      <label><span class="mmd-key">width</span><input class="s-width" type="number" min="32" step="32"></label>
      <label><span class="mmd-key">height</span><input class="s-height" type="number" min="32" step="32"></label>
      <label><span class="mmd-key">resize</span>
        <select class="s-ref">${["match", "max"].map((o) => `<option value="${o}">${o}</option>`).join("")}</select>
      </label>
      <label><span class="mmd-key">dialect</span>
        <select class="s-dialect" title="official follows MiniMax's own prompt guide; legacy is this pack's original labelled blocks">${["official", "legacy"].map((o) => `<option value="${o}">${o}</option>`).join("")}</select>
      </label>
      <span class="mmd-grow"></span>
      <span class="mmd-renders"></span>
      <span class="mmd-build" title="extension build">${BUILD}</span>`;

    const frames = (input) => Math.max(0, Math.round(Number(input.value) * FPS));

    const bind = (selector, apply) => {
      const node = this.settings.querySelector(selector);
      node.onchange = () => { const next = this.read(); apply(next, node); this.commit(next); };
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); node.blur(); }
      });
    };

    bind(".s-duration", (next, node) => { next.duration = frames(node); });
    bind(".s-dialect", (next, node) => { next.dialect = node.value; });

    const setWidget = (name, raw) => {
      const w = this.widgets[name];
      if (!w) return;
      w.value = raw;
      w.callback?.(raw);
    };
    this.settings.querySelector(".s-width").onchange = (e) => setWidget("width", Math.max(32, +e.target.value));
    this.settings.querySelector(".s-height").onchange = (e) => setWidget("height", Math.max(32, +e.target.value));
    this.settings.querySelector(".s-ref").onchange = (e) => setWidget("ref_image_size", e.target.value);
  }

  segment(track, index, item, scale) {
    const node = document.createElement("div");
    node.className = "mmd-seg";
    if (this.isSelected(track, index)) node.classList.add("mmd-sel");
    // Survives the re-render each drag frame triggers, so the block being resized stays
    // marked for the whole gesture rather than flickering.
    if (this.drag && this.drag.mode !== "body"
        && this.drag.track === track && this.drag.index === index) {
      node.classList.add("mmd-resizing");
    }
    node.dataset.index = index;
    node.style.left = `${item.start * scale}px`;
    node.style.width = `${Math.max(item.length * scale, 14)}px`;

    if (item.media) media.decorate(node, item.media);

    const caption = document.createElement("span");
    caption.className = "mmd-cap";
    caption.textContent = item.prompt?.trim() || item.camera || "";
    node.appendChild(caption);

    if (item.media?.filename) {
      const chip = document.createElement("span");
      chip.className = "mmd-chip";
      chip.textContent = `${item.media.kind.toUpperCase()} · ${item.media.filename}`;
      node.appendChild(chip);
    }

    node.insertAdjacentHTML(
      "beforeend", '<div class="mmd-grip mmd-l"></div><div class="mmd-grip mmd-r"></div>');
    return node;
  }

  /** Repaint one segment's caption without redrawing the tracks.
   *
   * Typing in the prompt box has to show on the block immediately; a full render would
   * fight the caret. Any selector here has to stay in step with `segment()` -- an
   * earlier rename left this looking for `.cap`, so the caption silently never updated.
   */
  refreshLabel(item) {
    if (!this.selection) return;
    const { track, index } = this.selection;
    const node = this.canvas.querySelector(
      `[data-track="${track}"] [data-index="${index}"] .mmd-cap`);
    if (node) node.textContent = item.prompt?.trim() || item.camera || "";
  }

  renderPanel(timeline) {
    if (document.activeElement !== this.global) this.global.value = timeline.global_prompt || "";
    if (document.activeElement !== this.music) this.music.value = timeline.music || "";

    if (!this.selection) {
      this.segPrompt.value = "";
      this.segPrompt.disabled = true;
      this.segFields.innerHTML = "";
      this.panelShape = null;
      this.range.textContent = this.selected.length
        ? `${this.selected.length} segments selected`
        : "no segment selected";
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

    // Only the CAMERA track. A shot used to carry one too, which meant the same sentence
    // could be written in two places -- inline on the shot's line, or in the Camera:
    // block -- with nothing on screen to say which you were getting.
    const cameras = track !== "moves" ? "" : `
      <label>camera
        <select class="mmd-f-camera">
          ${CAMERAS.map((name) =>
            `<option value="${name}"${name === (item.camera || "") ? " selected" : ""}>${name || "—"}</option>`
          ).join("")}
        </select>
      </label>`;

    const patch = (change) => {
      const next = this.read();
      Object.assign(items(next, track)[index], change);
      this.commit(next);
    };

    // Written on every keystroke so the block moves as you type, but one undo step per
    // burst rather than per character -- the same bargain the prompt boxes make.
    //
    // A typed number also grows the clip when it has to. Dragging stays inside the
    // duration because a gesture is aimed at a place on screen, but typing a length is
    // a statement of intent, and refusing it leaves no way to make a segment longer
    // than the clip except editing the duration first and the block second.
    const patchLive = (change) => {
      this.snapshotTyping();
      const next = this.read();
      const target = items(next, track)[index];
      Object.assign(target, change);
      const end = target.start + target.length;
      if (end > ceiling(next)) next.duration = end;
      this.write(next);
      this.render();
    };

    // Rebuilding the markup on every render would destroy whatever is being typed, so
    // it happens only when the panel is actually a different shape. Everything else is
    // an in-place value update below.
    const shape = `${track}:${index}:${item.media ? 1 : 0}`;
    if (this.panelShape !== shape) {
      this.panelShape = shape;
      this.segFields.innerHTML = `
        <label>start <input class="mmd-f-start" type="number" min="0" step="1"></label>
        <label>seconds <input class="mmd-f-secs" type="number" min="0.04" step="0.01"></label>
        <label>frames <input class="mmd-f-len" type="number" min="1" step="1"></label>
        ${cameras}
        ${item.media ? '<button class="mmd-f-unlink">detach media</button>' : ""}`;

      const secsEl = this.segFields.querySelector(".mmd-f-secs");
      const lenEl = this.segFields.querySelector(".mmd-f-len");

      // Seconds and frames are two views of one number. Whichever you are not typing
      // into follows immediately; the document only ever stores frames.
      // The same ceiling the drag obeys: typing a length may not push past the clip
      // either, or the two ways of editing would disagree about what is legal.
      const setLength = (frames) => {
        const now = this.read();
        const here = items(now, track)[index] || item;
        // Neighbours still bound it -- two segments cannot describe the same frames --
        // but the end of the clip does not, because the clip follows what you type.
        const room = neighbours(now, track, index)[1] - here.start;
        const wanted = Math.round(frames);
        const n = Math.max(1, Math.min(wanted, room));

        // The field under the cursor is normally left alone, so typing is not fought.
        // A refused number is the exception: showing what was typed while the timeline
        // holds something else means the two boxes disagree, and one of them is lying.
        const refused = n !== wanted;
        if (refused || secsEl !== document.activeElement) {
          secsEl.value = toSeconds(n).toFixed(2);
        }
        if (refused || lenEl !== document.activeElement) lenEl.value = n;
        patchLive({ length: n });
      };

      // A number input reports "" for anything half-typed -- "2." is not a number yet.
      // Treating that as zero clamped the block to one frame and then wrote the result
      // back over the field, so "2.5" came out as "0.045".
      const typed = (el) => (el.value.trim() === "" ? null : Number(el.value));

      secsEl.addEventListener("input", () => {
        const value = typed(secsEl);
        if (value !== null && Number.isFinite(value)) setLength(value * FPS);
      });
      lenEl.addEventListener("input", () => {
        const value = typed(lenEl);
        if (value !== null && Number.isFinite(value)) setLength(value);
      });
      this.segFields.querySelector(".mmd-f-start")
        .addEventListener("input", (e) => {
          if (e.target.value.trim() === "") return;
          const wanted = Math.round(Number(e.target.value));
          if (!Number.isFinite(wanted)) return;

          const now = this.read();
          const here = items(now, track)[index] || item;
          const [floor, roof] = neighbours(now, track, index);
          const top = Math.max(floor, roof - here.length);
          const start = Math.max(floor, Math.min(wanted, top));
          if (start !== wanted) e.target.value = start;
          patchLive({ start });
        });
      this.segFields.querySelector(".mmd-f-camera")
        ?.addEventListener("change", (e) => patch({ camera: e.target.value }));
      this.segFields.querySelector(".mmd-f-unlink")
        ?.addEventListener("click", () => {
          const next = this.read();
          delete items(next, track)[index].media;
          this.panelShape = null;
          this.commit(next);
        });
    }

    // Never write into the field under the cursor -- that is what eats keystrokes.
    const put = (selector, value) => {
      const el = this.segFields.querySelector(selector);
      if (el && el !== document.activeElement) el.value = value;
    };
    put(".mmd-f-start", item.start);
    put(".mmd-f-secs", toSeconds(item.length).toFixed(2));
    put(".mmd-f-len", item.length);
    put(".mmd-f-camera", item.camera || "");
  }
}
