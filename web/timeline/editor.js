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

import { api } from "../../../scripts/api.js";
import { ICON } from "./icons.js";
import { install } from "./styles.js";
import * as media from "./media.js";
import {
  AMPLITUDES, CAMERAS, ROLES, SPEEDS, TRANSITIONS, TRACKS, TRACK_FOR_MEDIA, add, bounds,
  emptyTimeline, extent as clipExtent, formatSeconds, speakerIds, speakerNumbers,
  items, length, neighbours, retentionsFor,
  remove, reshape, snapUp, span, stretchFor, toSeconds, FPS, STRIDE, PHASE,
  audioOf, filesOf,
} from "./model.js";


/**
 * The camera vocabulary as `<option>`s, with `current` selected.
 *
 * A hand-edited document can hold a verb this build has never heard of, and the compiler
 * passes an unknown value through untouched -- so it is offered as its own option rather
 * than dropped. A select that silently shows `static` for a block saying something else
 * is lying about the document. The empty value never arrives here: `parse` reads it as
 * `static`.
 */
const cameraOptions = (current) => {
  const value = current || "static";
  const names = CAMERAS.includes(value) ? CAMERAS : [value, ...CAMERAS];
  return names
    .map((name) => `<option value="${name}"${name === value ? " selected" : ""}>${name}</option>`)
    .join("");
};

/**
 * The four retention markers as `<option>`s, with `current` selected.
 *
 * Same bargain as `cameraOptions`: a value this build does not know is offered rather
 * than dropped, so the control never shows something the document does not say. The
 * compiler falls back to `fully_preserved` for an unknown marker; the select does not
 * pretend that already happened.
 */
const roleOptions = (current) => {
  const value = ROLES.includes(current) ? current : ROLES[0];
  return ROLES
    .map((name) => `<option value="${name}"${name === value ? " selected" : ""}>${name}</option>`)
    .join("");
};

/**
 * Retention markers as `<option>`s -- the visual four, or the audio four for an audio
 * file, which has a vocabulary of its own in H3's format rather than a translation of the
 * visual one. `kind` is the file's, never the author's choice.
 *
 * Same bargain as `cameraOptions`: a value this build does not know is offered rather than
 * dropped, so the control never shows something the document does not say. That covers the
 * document written before the two sets were told apart, where an audio file still holds a
 * visual marker -- the compiler translates it, and this shows what is actually stored.
 */
const retentionOptions = (current, kind = "image") => {
  const all = retentionsFor(kind);
  const value = current || all[0];
  const names = all.includes(value) ? all : [value, ...all];
  return names
    .map((name) => `<option value="${name}"${name === value ? " selected" : ""}>${name}</option>`)
    .join("");
};

/** A picker whose empty option is a real answer, not a blank: the guide's own default. */
const scaleOptions = (values, current, blank) => values
  .map((name) => `<option value="${name}"${name === (current || "") ? " selected" : ""}>`
    + `${name || blank}</option>`)
  .join("");

const transitionOptions = (current) => {
  const value = TRANSITIONS.includes(current) ? current : TRANSITIONS[0];
  return TRANSITIONS
    .map((name) => `<option value="${name}"${name === value ? " selected" : ""}>${name}</option>`)
    .join("");
};

/** What to call somebody on screen: their name, else what they look like, else S-number. */
const nameOf = (card) =>
  card.name.trim()
  || card.description.replace(/[:,].*$/, "").trim()
  || `speaker ${card.id}`;

/** Anything a keystroke could legitimately be typed into. */
const isEditable = (el) =>
  !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

const ZOOM_STEP = 1.35;
const HISTORY_LIMIT = 100;
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
    // Every persist re-compiles the preview. Wrapping the injected writer here catches
    // all of them -- typing, dragging, undo -- without a call at each of the ten sites.
    this.write = (timeline) => {
      write(timeline);
      this.schedulePreview();
    };
    this.widgets = widgets;
    /** Called after every panel render, so the host can remember what was selected. */
    this.onState = null;
    this.selected = [];
    this.drag = null;
    this.scrubbing = false;
    /** Blocks copied with Cmd/Ctrl+C, waiting for a paste. Not the system clipboard: a
     *  timeline block is not text, and reading the real one needs a permission prompt. */
    this.clipboard = null;
    this.panelShape = null;
    this.marquee = null;
    /** `fit`: the whole clip on screen from the first click. Opening two steps in showed
     *  captions at full width but hid the end of the piece, and a timeline you cannot see
     *  the end of is the one thing a timeline is for. */
    this.zoom = 1;
    this.playhead = 0;

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
        <button data-reset="1" title="Empty the timeline: every block, the global prompt and the music. Cmd/Ctrl+Z puts it back.">${ICON.reset} Clear</button>
        <span class="mmd-grow"></span>
      </div>

      <div class="mmd-settings"></div>

      <div class="mmd-tabbed">
      <div class="mmd-tabs">
        <button class="mmd-tab mmd-on" data-tab="timeline">TIMELINE</button>
        <button class="mmd-tab" data-tab="cast">CAST <span class="mmd-tab-count"></span></button>
        <button class="mmd-tab" data-tab="global">GLOBAL</button>
      </div>

      <div class="mmd-panel" data-panel="timeline">
      <div class="mmd-stage">
        <div class="mmd-labels">
          ${TRACKS.map((t) => `<div class="mmd-label" data-for="${t.key}">${t.label}</div>`).join("")}
        </div>
        <div class="mmd-scroll">
          <div class="mmd-canvas">
            <div class="mmd-ruler"></div>
            ${TRACKS.map((t) => `<div class="mmd-track" data-track="${t.key}"></div>`).join("")}
            <div class="mmd-end"></div>
            <div class="mmd-playhead"><div class="mmd-head-grip"></div></div>
          </div>
        </div>
      </div>

      <div class="mmd-transport">
        <span class="mmd-clock" title="Where the playhead is">0.00s</span>
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

      </div>

      <div class="mmd-panel mmd-hide" data-panel="cast"></div>

      <div class="mmd-panel mmd-hide" data-panel="global">
      <div class="mmd-globals">
        <div class="mmd-prompt">
          <label>GLOBAL PROMPT</label>
          <textarea class="mmd-global" placeholder="Style and scene constants for the whole clip"></textarea>
        </div>

        <div class="mmd-prompt">
          <label title="non_diegetic_music: score only the audience hears. Instrumentation, tempo and dynamics -- not mood words. Left empty it compiles to N/A.">GLOBAL MUSIC <span class="mmd-hint">audience only, never the characters</span></label>
          <textarea class="mmd-music" placeholder="Sparse piano notes at a slow tempo, joined by low strings that fade out"></textarea>
        </div>
      </div>
      </div>
      </div>`;

    // The two globals are one row, so they resize as one. Dragging one alone left a tall
    // box beside a short one -- a layout nobody chose, just the one the last drag happened
    // to leave behind.
    this.pairHeights(".mmd-global", ".mmd-music");

    this.bar = this.root.querySelector(".mmd-bar");
    this.tabs = this.root.querySelector(".mmd-tabs");
    this.panels = [...this.root.querySelectorAll(".mmd-panel")];
    /** Where the cast editor mounts, when the host gives us one. */
    this.castPanel = this.root.querySelector('[data-panel="cast"]');
    this.settings = this.root.querySelector(".mmd-settings");
    this.stage = this.root.querySelector(".mmd-scroll");
    this.canvas = this.root.querySelector(".mmd-canvas");
    this.ruler = this.root.querySelector(".mmd-ruler");
    this.head = this.root.querySelector(".mmd-playhead");
    this.end = this.root.querySelector(".mmd-end");
    this.clock = this.root.querySelector(".mmd-clock");
    this.range = this.root.querySelector(".mmd-range");
    this.scrub = this.root.querySelector(".mmd-scrub");
    this.segPrompt = this.root.querySelector(".mmd-seg-prompt");
    this.segFields = this.root.querySelector(".mmd-seg-fields");
    this.global = this.root.querySelector(".mmd-global");
    this.music = this.root.querySelector(".mmd-music");

    /**
     * Where a freshly compiled prompt goes.
     *
     * The editor used to render it itself, in a panel below the prompt boxes. That panel
     * was the tallest thing on the node and it grew *after* the node had been sized --
     * the compile is a round trip -- so it hung through the bottom of the node and drew
     * over whatever sat below it on the graph. The compiled string belongs on the node
     * wired to the `prompt` output, which is where a reader looks for it anyway.
     *
     * Set by the host; left null the compile still runs and the answer is simply dropped.
     */
    this.onPreview = null;

    this.bind();
    this.schedulePreview();
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
      else if (el.dataset.reset) this.clear();
      else if (el.dataset.zoom) this.setZoom(el.dataset.zoom);
    });

    // Delete / Backspace remove the selected segment.
    //
    // This has to listen on the document in the capture phase. Clicking a segment does
    // not leave focus inside the widget -- LiteGraph pulls it straight back to <body> --
    // so a listener on our own element never fires. Capture also puts us ahead of
    // ComfyUI's handler, which binds the same key to "delete the selected node": without
    // stopping the event, deleting a shot would delete the whole Director.
    //
    // Focus is what scopes it: the editor answers for these keys only when it was the
    // thing last clicked, so a Delete aimed at a node next to it still reaches the graph.
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

      if (this.active && chord && key === "v" && this.clipboard?.length) {
        event.preventDefault();
        event.stopPropagation();
        this.paste();
        return;
      }

      // Focus is what scopes these, not the existence of a selection. They used to be
      // scoped by throwing the selection away on any click outside the editor, which kept
      // Delete off the graph and cost the author their selected block for looking at a
      // node next to it.
      if (!this.active || !this.selected.length) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        event.stopPropagation();
        this.deleteSelected();
      } else if (key === "s" && !chord) {
        event.preventDefault();
        event.stopPropagation();
        this.splitSelected();
      } else if (chord && key === "c") {
        event.preventDefault();
        event.stopPropagation();
        this.copySelected();
      } else if (chord && key === "d") {
        event.preventDefault();
        event.stopPropagation();
        this.copySelected();
        this.paste();
      } else if (event.key === "Escape") {
        event.stopPropagation();
        this.selected = [];
        this.applySelection();
      }
    }, true);

    // A click outside the editor gives the keyboard back to ComfyUI.
    document.addEventListener("pointerdown", (event) => {
      this.active = this.root.contains(event.target);
    }, true);

    this.tabs.addEventListener("click", (event) => {
      const tab = event.target.closest(".mmd-tab");
      if (tab) this.showTab(tab.dataset.tab);
    });

    this.canvas.addEventListener("pointerdown", (event) => this.grab(event));
    this.canvas.addEventListener("dblclick", (event) => this.editInPlace(event));
    this.canvas.addEventListener("change", (event) => {
      if (event.target.classList.contains("mmd-cam-pick")) this.setCamera(event);
      if (event.target.classList.contains("mmd-keep-pick")) this.setRetention(event);
    });
    document.addEventListener("pointermove", (event) => this.move(event));
    document.addEventListener("pointerup", () => {
      // A drag paints only the blocks it touched, so the tracks are redrawn once here --
      // captions, chips and the panel catch up with the document in one pass rather than
      // being rebuilt under the cursor on every pointermove.
      const dragged = this.drag?.recorded;
      this.drag = null;
      this.scrubbing = false;
      this.root.classList.remove("mmd-dragging");
      for (const node of this.canvas.querySelectorAll(".mmd-resizing")) {
        node.classList.remove("mmd-resizing");
      }
      if (this.marquee) this.endMarquee();
      if (dragged) this.render();
    });

    this.scrub.addEventListener("input", () => {
      const extent = this.extent();
      this.seek((this.scrub.value / 1000) * extent, extent);
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
   * Re-compile the prompt panel, once the edits stop.
   *
   * Debounced because the compiler lives in Python: a request per keystroke would be one
   * round trip per character, and the answers could land out of order. The trailing edge
   * is the only one that matters -- what the panel must end up showing is the document
   * as it stands after typing, not any state on the way there.
   */
  schedulePreview() {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.refreshPreview(), 300);
  }

  async refreshPreview() {
    // A slow answer to an old document must never overwrite a newer one. Each request
    // carries a serial; only the newest is allowed to paint.
    const serial = (this.previewSerial = (this.previewSerial ?? 0) + 1);
    const timeline = JSON.stringify(this.read());

    let result;
    try {
      const response = await api.fetchApi("/minimax_director/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeline, cast: this.castJSON?.() || "" }),
      });
      if (!response.ok) throw new Error(`compile failed: ${response.status}`);
      result = await response.json();
    } catch (error) {
      if (serial !== this.previewSerial) return;
      this.paintPreview({ ok: false, error: String(error.message ?? error) });
      return;
    }

    if (serial !== this.previewSerial) return;
    this.paintPreview(result);
  }

  paintPreview(result) {
    this.preview = result;
    this.onPreview?.(result);
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

  /**
   * Put a snapshot back, keeping whatever of the selection still exists.
   *
   * The selection used to be dropped outright, which is safe and wrong: undoing a change
   * *to* a block leaves you looking at the block, and having to re-find and re-click it is
   * the moment an undo stops feeling like an undo. Only indices naming a block that is no
   * longer there are discarded -- those would point at somebody else's block, and a Delete
   * aimed at one of those is the bug this was avoiding.
   */
  restore(json) {
    this.typing = null;
    const timeline = JSON.parse(json);
    const alive = ({ track, index }) => !!items(timeline, track)[index];

    this.selected = this.selected.filter(alive);
    if (this.selection && !alive(this.selection)) this.selection = null;
    if (!this.selection) this.selection = this.selected[0] ?? null;
    // The panel is rebuilt rather than updated: an undo can put a file back, and the
    // fields for one are only built when the block has it.
    this.panelShape = null;

    this.write(timeline);
    this.render();
  }

  // -- actions -------------------------------------------------------------

  append(track) {
    const timeline = this.read();
    this.selection = { track, index: add(timeline, track, 1.5, this.playhead) };
    this.commit(timeline);
  }

  /**
   * Refresh the block's speaker list without a render.
   *
   * A full render would rebuild the cast row being typed into and take the caret with it,
   * which is why `setVoice` only writes -- but the picker names the person whose
   * description is being typed, and left alone it went on calling them undescribed.
   */
  paintPicker(timeline) {
    if (!this.selection) return;
    const { track, index } = this.selection;
    const lines = items(timeline, track)[index]?.lines || [];
    for (const row of this.segFields.querySelectorAll(".mmd-f-line-row")) {
      const chips = row.querySelector(".mmd-f-chips");
      if (chips) chips.innerHTML = this.chips(timeline, lines[Number(row.dataset.line)]?.ids);
    }
  }

  /**
   * Who speaks this line, as faces rather than a dropdown.
   *
   * Two clicks make a chorus -- the guide's `(S1,S2)` -- which a single-select could only
   * express through a "several speakers…" mode and a box of comma-separated numbers.
   */
  /**
   * Show one panel of the node.
   *
   * The cast is a list of people, not part of the timeline, and it is read while writing
   * dialogue rather than continuously -- so it takes the same space rather than its own.
   * A tab costs nothing when you are not looking at it, which is the whole point on a
   * node this tall.
   */
  showTab(name) {
    // Measured on the way out, while the timeline is still laid out: the cast then opens
    // at the same height instead of the node jumping to a different one and back.
    this.rememberPanelHeight();
    this.tab = name;
    for (const tab of this.tabs.querySelectorAll(".mmd-tab")) {
      tab.classList.toggle("mmd-on", tab.dataset.tab === name);
    }
    for (const panel of this.panels) {
      panel.classList.toggle("mmd-hide", panel.dataset.panel !== name);
    }
    this.onTab?.(name);
  }

  /** The height the cast list should open at: the room the timeline was using. */
  rememberPanelHeight() {
    const timeline = this.panels.find((panel) => panel.dataset.panel === "timeline");
    const height = timeline && !timeline.classList.contains("mmd-hide")
      ? timeline.offsetHeight : 0;
    if (height > 0) this.root.style.setProperty("--mmd-cast-height", `${height}px`);
  }

  /** How many people are in the cast, shown on the tab so it is not a mystery door. */
  paintTabCount(count) {
    const badge = this.tabs.querySelector(".mmd-tab-count");
    if (badge) badge.textContent = count ? `· ${count}` : "";
  }

  /** Keep two resizable boxes at one height: whichever is dragged, both follow. */
  pairHeights(...selectors) {
    const boxes = selectors
      .map((selector) => this.root.querySelector(selector))
      .filter(Boolean);
    if (boxes.length < 2) return;

    let syncing = false;
    const observer = new ResizeObserver((entries) => {
      // Writing the height provokes the observer again; one frame of quiet ends it.
      if (syncing) return;
      const dragged = entries[entries.length - 1].target;
      const height = getComputedStyle(dragged).height;
      syncing = true;
      for (const box of boxes) if (box !== dragged) box.style.height = height;
      requestAnimationFrame(() => { syncing = false; });
    });
    for (const box of boxes) observer.observe(box);
  }

  /**
   * Make room for the node's own sockets, which this element is drawn on top of.
   *
   * The editor is pulled up to the title so the band of empty node beside ten input
   * labels stops being wasted -- but a DOM widget covers the canvas, so the strips the
   * sockets and their labels occupy have to stay visually clear *and* let a click
   * through. Only the toolbar and the settings row fit up there; the timeline stage is
   * full width, so it waits until the band is over.
   *
   * @param {number} height  how much of the element the sockets reach down, in px
   */
  setBand(height) {
    const banded = height > 0;
    this.root.classList.toggle("mmd-banded", banded);
    if (!banded) return;

    // The tab strip belongs to the panel below it now, not to the band: it is the panel's
    // own header, and a header that floats away from what it heads reads as a mistake.
    const above = [this.bar, this.settings];
    const rows = above.reduce((sum, el) => sum + (el?.offsetHeight || 0), 0)
      + (parseFloat(getComputedStyle(this.root).rowGap) || 0) * above.length;
    this.root.style.setProperty("--mmd-band-gap", `${Math.max(0, Math.round(height - rows))}px`);
  }

  /** Whether anybody speaks: the cast node's switch, with no cast node meaning no. */
  speaks() {
    const cast = this.castOf?.();
    return !!cast && cast.speech !== false;
  }

  chips(timeline, ids) {
    const chosen = speakerNumbers(ids);
    const cast = this.castOf?.();
    if (!cast) {
      return `<span class="mmd-f-nobody">no cast node connected — add a
        <b>MiniMax Director — Cast</b> and wire its <b>cast</b> output here</span>`;
    }
    if (!cast.cards.length) {
      // A line needs somebody to speak it, and the place to add them is one tab away --
      // so the sentence saying so is the way there, rather than an instruction to follow.
      return `<span class="mmd-f-nobody">nobody in the cast yet —
        <button type="button" class="mmd-f-tocast">add a character</button></span>`;
    }

    const files = filesOf(timeline);
    const fileOf = (card) =>
      files.find((item) => (item.media.filename || "") === card.file) || null;

    // A line may name somebody the cast no longer has: removing a card leaves the lines
    // that quoted them alone, on purpose. The chip stays and says so, because a picker
    // that disagrees with the document it is editing is worse than an awkward chip.
    const orphans = chosen.filter((number) =>
      !cast.cards.some((card) => card.id === number));

    return cast.cards.map((card) => `
      <button class="mmd-f-chip${chosen.includes(card.id) ? " mmd-on" : ""}"
              data-speaker="${card.id}"
              title="${card.voice ? String(card.voice).replace(/"/g, "&quot;") : "no voice described yet"}">
        ${this.face(fileOf(card))}
        <span>${nameOf(card)}</span>
      </button>`).join("")
      + orphans.map((number) => `
      <button class="mmd-f-chip mmd-on mmd-f-orphan" data-speaker="${number}"
              title="This line names a speaker the cast no longer has. Click to drop them.">
        <span class="mmd-face mmd-face-none">?</span><span>S${number} — not in the cast</span>
      </button>`).join("");
  }

  /**
   * A person's face, as small as it needs to be.
   *
   * A video cannot be a CSS background, so it stays a real element and a media fragment
   * asks the browser for a frame a little way in -- frame zero of a cut is often black.
   */
  face(file) {
    const src = file ? media.url(file.media) : null;
    if (!src) return `<span class="mmd-face mmd-face-none">?</span>`;
    if (file.media.kind === "video") {
      return `<video class="mmd-face" src="${src}#t=0.6" muted preload="metadata"></video>`;
    }
    return `<span class="mmd-face" style="background-image:url('${src}')"></span>`;
  }

  /**
   * Empty the timeline.
   *
   * Everything: the blocks on all three tracks, the global prompt, the music, the clip
   * settings the document owns. Deleting blocks one selection at a time leaves the prose
   * behind, and a global prompt describing a scene that no longer exists is the kind of
   * leftover that ends up in a render.
   *
   * One undo step, and the confirm is skipped for a document that is already empty --
   * asking whether to clear nothing is a dialog with one correct answer.
   */
  clear() {
    const current = this.read();
    const populated = TRACKS.some(({ key }) => items(current, key).length)
      || current.global_prompt?.trim() || current.music?.trim();
    if (populated && !confirm("Clear the timeline? Cmd/Ctrl+Z puts it back.")) return;

    this.selected = [];
    this.selection = null;
    this.panelShape = null;
    this.playhead = 0;
    // The duration is kept: it is a property of the piece being made, not of its content,
    // and clearing it would silently drop back to whatever the blocks happened to need.
    this.commit({ ...emptyTimeline(), duration: current.duration || 0 });
  }

  /**
   * Remember the selected blocks, keeping their spacing.
   *
   * Positions are stored relative to the earliest one, so a pair of blocks two seconds
   * apart is still two seconds apart wherever it lands. A deep copy, or a paste would
   * hand out references into a document that has since been edited.
   */
  copySelected() {
    if (!this.selected.length) return;
    const timeline = this.read();

    const picked = this.selected
      .map(({ track, index }) => ({ track, item: items(timeline, track)[index] }))
      .filter(({ item }) => item);
    if (!picked.length) return;

    const first = Math.min(...picked.map(({ item }) => item.start));
    this.clipboard = picked.map(({ track, item }) => ({
      track,
      offset: item.start - first,
      item: JSON.parse(JSON.stringify(item)),
    }));
  }

  /**
   * Drop the clipboard at the playhead, on the tracks it came from.
   *
   * A copy that will not fit is placed at the end of its track instead of being refused,
   * the same bargain Add makes: a paste that silently does nothing reads as broken.
   */
  paste() {
    if (!this.clipboard?.length) return;
    const timeline = this.read();
    const pasted = [];

    for (const entry of this.clipboard) {
      const at = this.playhead + entry.offset;
      const index = add(timeline, entry.track, entry.item.length / FPS, at);
      const target = items(timeline, entry.track)[index];
      // The length `add` granted stands: it is what fits in the gap. Everything the block
      // says about itself comes across.
      const { start, length: granted } = target;
      Object.assign(target, JSON.parse(JSON.stringify(entry.item)), { start, length: granted });
      pasted.push({ track: entry.track, index });
    }

    this.selected = pasted;
    this.selection = pasted[0] ?? null;
    this.commit(timeline);
  }

  /**
   * Warn when a reference clip is outside the length H3 accepts.
   *
   * Stored on the record, so the note survives a reload and a lint run rather than being
   * a message that scrolled past. The check is skipped when the browser cannot read a
   * duration: an unknown length is not a wrong one.
   */
  async checkDuration(track, index, record) {
    const length = await media.seconds(record);
    if (length === null) return;

    const rounded = Math.round(length * 10) / 10;
    const next = this.read();
    const target = items(next, track)[index];
    if (!target?.media || target.media.filename !== record.filename) return;

    target.media = { ...target.media, seconds: rounded };
    this.commit(next);

    if (rounded < 2 || rounded > 15) {
      console.warn(
        `[MiniMaxDirector] ${record.filename} is ${rounded}s; H3 takes reference clips of 2-15s.`);
    }
  }

  /**
   * Cut the selected blocks in two at the playhead.
   *
   * A cut is the one edit that needs a position rather than a size, which is what the
   * playhead is for. Blocks the playhead is not standing inside are skipped rather than
   * refused as a group: splitting a multi-track selection should do the tracks it can.
   *
   * The tail keeps the prose and drops the file. Copying the attachment would put the
   * same picture in the prompt twice under two tokens, and a reference the author never
   * added is worse than one they have to add back.
   */
  splitSelected() {
    const timeline = this.read();
    const at = this.playhead;
    let cut = false;

    // Highest index first: an insert shifts everything after it, and the indices still to
    // come were read before that happened.
    for (const { track, index } of [...this.selected].sort((a, b) => b.index - a.index)) {
      const list = items(timeline, track);
      const item = list[index];
      if (!item || at <= item.start || at >= item.start + item.length) continue;

      const tail = { ...item, start: at, length: item.start + item.length - at };
      delete tail.media;
      item.length = at - item.start;
      list.splice(index + 1, 0, tail);
      cut = true;
    }

    if (!cut) return;
    // Every index after a split moved, so the selection now names blocks it did not mean.
    // Nothing selected is honest; the wrong block selected is what deletes the wrong block.
    this.selected = [];
    this.selection = null;
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

    // A selected block on the right track with nothing attached takes the file; anything
    // else gets a block of its own. The rule used to be "always a new segment, never a
    // swap", which came from dropping a file onto a block that already had one and
    // destroying it -- a block with none has nothing to destroy, and an example that says
    // "one block waiting for an image" had no way to be true.
    const empty = this.selection?.track === track
      && items(timeline, track)[this.selection.index]
      && !items(timeline, track)[this.selection.index].media;
    const target = empty ? this.selection.index : add(timeline, track, 2, this.playhead);
    const item = items(timeline, track)[target];
    item.media = record;
    this.selection = { track, index: target };
    this.commit(timeline);

    // H3 takes reference clips of 2-15 seconds. Outside that the model does not refuse --
    // it quietly uses what it can -- so the only place this can be caught is here, and it
    // is worth catching before a generation rather than after one.
    if (kind !== "image") this.checkDuration(track, target, record);

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

  /**
   * Zoom around the playhead, the way an NLE does.
   *
   * Zooming about the start of the clip is only the right answer while the playhead is at
   * the start. Move it to 2.34s, press `+`, and the frames you were looking at leave the
   * window: you land back at 0.00 and have to scroll to where you already were. The
   * playhead is where the work is, so the view is recentred on it -- what you zoomed into
   * is what you were pointing at.
   */
  setZoom(mode) {
    if (mode === "fit") this.zoom = 1;
    else this.zoom = Math.min(24, Math.max(1, this.zoom * (mode === "in" ? ZOOM_STEP : 1 / ZOOM_STEP)));
    this.render();

    // Assigning past either end is clamped by the browser, which is exactly right: a
    // playhead near 0.00 or near the tail cannot be centred, and should not leave a band
    // of nothing on one side to pretend otherwise.
    this.stage.scrollLeft = this.playhead * this.scale() - this.stage.clientWidth / 2;
  }

  /**
   * Put the playhead on a frame.
   *
   * Frames are the unit the clip is cut in, so the playhead stands on one rather than
   * between two: it moved smoothly, which looks right and means the time in the readout
   * belongs to no frame in particular.
   */
  seek(frames, total = this.extent()) {
    this.playhead = Math.max(0, Math.min(total, Math.round(frames)));
    this.renderPlayhead(total);
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

  /** Frames the view covers: the clip as typed, or the content if it runs past it.
   *  Not the rendered length -- rounding up to the lattice here drew up to sixteen
   *  frames of empty track past the last block, for a duration nobody entered. */
  extent() {
    return Math.max(clipExtent(this.read()), 1);
  }

  // -- gestures ------------------------------------------------------------

  grab(event) {
    // An open inline editor owns its own clicks; starting a drag would close it. The
    // camera dropdown is the same bargain: a click there is aimed at the control, and
    // treating it as the start of a drag makes the move impossible to pick.
    if (event.target.closest(".mmd-inline, .mmd-cam-pick, .mmd-keep-pick")) return;

    // The playhead's head is a handle, not part of the tracks. Dragging it scrubs; letting
    // it fall through would start a marquee over the blocks underneath instead.
    if (event.target.closest(".mmd-head-grip")) {
      this.scrubbing = true;
      this.root.classList.add("mmd-dragging");
      event.target.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }

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
      factor: this.factor(),
      applied: null,
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

    // The gesture owns the block's appearance until the button comes up. The hover rules
    // are written for a pointer that is choosing something; during a drag the pointer is
    // already committed, and it spends the whole time crossing in and out of a 7px grip,
    // which made the outline strobe. `mmd-dragging` on the root switches those rules off
    // and `mmd-resizing` holds the outline on the block being dragged.
    this.root.classList.add("mmd-dragging");
    node.classList.add("mmd-resizing");
    // Keeps the moves coming even when the pointer outruns the block or leaves the node.
    node.setPointerCapture?.(event.pointerId);

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
      this.seek(x / this.scale(), total);
      this.selected = [];
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
   * A camera block's dropdown was changed.
   *
   * The select lives on the block permanently, so this is the whole interaction: read
   * which block it belongs to off the DOM, write the move, commit. Rendering after a
   * commit rebuilds the block and its select with it, and `keepFocus` puts the focus
   * back where it was.
   */
  setCamera(event) {
    const node = event.target.closest(".mmd-seg");
    if (!node) return;
    event.stopPropagation();

    const track = node.parentElement.dataset.track;
    const index = Number(node.dataset.index);
    const next = this.read();
    const target = items(next, track)[index];
    if (!target || track !== "moves") return;

    this.selection = { track, index };
    target.camera = event.target.value;
    this.commit(next);
  }

  /**
   * A media block's retention dropdown was changed.
   *
   * The marker belongs to the attachment, not the block, so it is written onto
   * `item.media` -- the same record `describes` lives on, and the one the compiler reads
   * when it builds `retention_analysis`.
   */
  setRetention(event) {
    const node = event.target.closest(".mmd-seg");
    if (!node) return;
    event.stopPropagation();

    const track = node.parentElement.dataset.track;
    const index = Number(node.dataset.index);
    const next = this.read();
    const target = items(next, track)[index];
    if (!target?.media) return;

    this.selection = { track, index };
    target.media = { ...target.media, retention: event.target.value };
    this.commit(next);
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

  /**
   * Pull a dragged value onto the playhead when it comes close.
   *
   * The playhead is the only landmark on the timeline, so it is the only thing worth
   * snapping to -- and it is the thing you put there on purpose. The tolerance is in
   * pixels, converted to frames at the current scale: seven pixels is seven pixels
   * whether the clip is zoomed out to five seconds or in to half of one, where a fixed
   * number of frames would be either unreachable or impossible to escape.
   *
   * `candidates` are values that would land an edge on the playhead. Out-of-range ones
   * are dropped rather than clamped: a snap that has to be moved to be legal is not the
   * position it promised.
   */
  snap(value, lowest, highest, candidates) {
    const tolerance = Math.max(1, Math.round(7 / (this.drag?.scale ?? this.scale())));
    let best = null;
    let distance = tolerance + 1;
    for (const candidate of candidates) {
      const gap = Math.abs(candidate - value);
      if (gap > tolerance || gap >= distance) continue;
      if (candidate < lowest || candidate > highest) continue;
      best = candidate;
      distance = gap;
    }
    return best === null ? value : best;
  }

  /**
   * Frames worth snapping to: the playhead, and the edge of every other block.
   *
   * Cuts want to line up across tracks -- an audio cue starting exactly where a shot does,
   * a camera move ending on the same frame as its shot -- and doing that by eye at a
   * pixel per frame is guesswork. Every track is offered, not just this one: a block's own
   * neighbours already stop it, and the interesting alignment is the one across tracks.
   *
   * The dragged blocks are excluded, or a group drag would snap to itself and stick.
   */
  landmarks(timeline) {
    const moving = new Set(
      (this.drag?.group ?? []).map((member) => `${member.track}:${member.index}`));

    const marks = [this.playhead, 0, clipExtent(timeline)];
    for (const { key } of TRACKS) {
      items(timeline, key).forEach((item, index) => {
        if (key === this.drag?.track && moving.has(`${key}:${index}`)) return;
        marks.push(item.start, item.start + item.length);
      });
    }
    return marks;
  }

  move(event) {
    if (this.scrubbing) {
      const [x] = this.toLocal(event.clientX, event.clientY);
      this.seek(x / this.scale());
      return;
    }

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

    // Measured from where the gesture began, never accumulated: every move recomputes the
    // whole travel, so the block is a function of where the pointer is and nothing else.
    // `factor` is the graph's zoom, read once at pointerdown -- it cannot change while a
    // button is held, and reading it per event forced a synchronous layout on every frame.
    const frames = Math.round(
      ((event.clientX - this.drag.originX) / this.drag.factor) / this.drag.scale);
    // Nothing new to say. Not an early return on `frames === 0`: zero is a real position,
    // the one the block started at, and skipping it left a block that had travelled a
    // frame and come back stuck a frame out for the rest of the drag.
    if (frames === this.drag.applied) return;
    this.drag.applied = frames;

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
      let shift = Math.max(lowest, Math.min(highest, frames));
      // Either edge may take the playhead -- whichever you brought to it is the one you
      // meant, and offering only the leading edge makes butting a block up against a cut
      // from the right impossible.
      const marks = this.landmarks(timeline);
      shift = this.snap(shift, lowest, highest, [
        ...marks.map((mark) => mark - this.drag.start),
        ...marks.map((mark) => mark - (this.drag.start + this.drag.length)),
      ]);
      for (const member of this.drag.group) {
        reshape(items(timeline, member.track)[member.index], { start: member.start + shift });
      }
    } else if (this.drag.mode === "start") {
      const finish = this.drag.start + this.drag.length;
      const start = this.snap(
        Math.min(Math.max(this.drag.start + frames, this.drag.limits[0]), finish - 1),
        this.drag.limits[0], finish - 1, this.landmarks(timeline));
      reshape(item, { start, length: finish - start });
    } else {
      const room = this.drag.limits[1] - this.drag.start;
      const span = this.snap(
        Math.max(1, Math.min(this.drag.length + frames, room)),
        1, room, this.landmarks(timeline).map((mark) => mark - this.drag.start));
      reshape(item, { length: span });
    }
    this.write(timeline);
    this.paintDrag(timeline);
  }

  /**
   * Move the blocks a drag is touching, without rebuilding the tracks.
   *
   * `render()` empties every lane and recreates every segment. Run on each pointermove --
   * up to the display's refresh rate -- that destroys and rebuilds the very element under
   * the cursor, which is what the flicker was, and it throws away the hover and resizing
   * outlines with it. A drag only ever changes where some blocks sit and how wide they
   * are, and those are two style properties.
   *
   * The clip readout and the end marker still follow, because a resize can change the
   * length of the whole piece. `scale()` is frozen for the gesture, so nothing else on the
   * canvas can have moved.
   */
  paintDrag(timeline) {
    const scale = this.scale();
    const touched = this.drag.mode === "body"
      ? this.drag.group
      : [{ track: this.drag.track, index: this.drag.index }];

    for (const { track, index } of touched) {
      const item = items(timeline, track)[index];
      const node = this.canvas.querySelector(
        `[data-track="${track}"] [data-index="${index}"]`);
      if (!item || !node) continue;
      node.style.left = `${item.start * scale}px`;
      node.style.width = `${Math.max(item.length * scale, 14)}px`;
    }

    this.end.style.left = `${this.extent() * scale}px`;
    this.renderSettings(timeline);
    this.rememberPanelHeight();

    // The numbers under the timeline are the only exact reading of what a drag is doing;
    // a resize with them frozen is a resize done by eye.
    const held = items(timeline, this.drag.track)[this.drag.index];
    if (held) {
      this.range.textContent =
        `Start: ${toSeconds(held.start).toFixed(2)} | ` +
        `End: ${toSeconds(held.start + held.length).toFixed(2)} | ` +
        `Length: ${toSeconds(held.length).toFixed(2)}`;
      const put = (selector, value) => {
        const field = this.segFields.querySelector(selector);
        if (field && field !== document.activeElement) field.value = value;
      };
      put(".mmd-f-start", held.start);
      put(".mmd-f-end", held.start + held.length);
      put(".mmd-f-len", held.length);
      // The mirrors are spans, not fields: they take text, and no caret can be in them.
      const show = (selector, value) => {
        const el = this.segFields.querySelector(selector);
        if (el) el.textContent = value;
      };
      show(".mmd-f-start-secs", toSeconds(held.start).toFixed(2));
      show(".mmd-f-end-secs", toSeconds(held.start + held.length).toFixed(2));
      show(".mmd-f-secs", toSeconds(held.length).toFixed(2));
    }
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
    const scale = this.scale();
    this.canvas.style.width = `${this.width() + TAIL}px`;
    this.end.style.left = `${extent * scale}px`;

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
    // Frames first: the document is cut in frames, every field types frames, and a
    // reading in seconds alone could not be typed back into any of them.
    this.clock.textContent = `${this.playhead} f = ${toSeconds(this.playhead).toFixed(2)}s`;
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
    set(".s-duration", timeline.duration || rendered);
    // Locked, so it is never the field under the cursor and needs no guard.
    const mirror = this.settings.querySelector(".s-duration-secs");
    if (mirror) mirror.textContent = secs(timeline.duration || rendered);
    set(".s-width", widget("width") ?? 1344);
    set(".s-height", widget("height") ?? 768);
    set(".s-ref", widget("ref_image_size") ?? "match");

    // The lattice appears here and nowhere else. A typed duration is left alone; this
    // says what will actually be generated, which is where the 17-frame grid bites.
    const asked = timeline.duration || span(timeline);
    // Only when the number typed is not the number generated. Saying "renders 124 frames"
    // beside a duration box reading 124 was the same fact twice; the rounding is the part
    // that is news, and it is the only part H3's lattice actually surprises you with.
    this.settings.querySelector(".mmd-renders").textContent =
      rendered !== asked ? `renders ${rendered} f = ${(rendered / FPS).toFixed(2)}s` +
        ` · ${asked} f rounded up` : "";
  }

  /** The settings row, built once. */
  buildSettings() {
    this.settings.innerHTML = `
      <label title="Length of the whole piece, in frames. H3 only accepts 17n+5, so the arrows step a whole lattice slot."><span class="mmd-key">duration</span><input class="s-duration" type="number" min="${PHASE}" step="${STRIDE}"><span class="mmd-unit">f</span></label>
      <label class="mmd-f-locked" title="The same length in seconds. Read-only: the lattice is counted in frames, and a rounded second typed back would not land on it."><span class="mmd-key">=</span><span class="mmd-mirror s-duration-secs"></span><span class="mmd-unit">s</span></label>
      <label title="MiniMax H3 always generates at 24 fps -- the model has no other rate"><span class="mmd-key">frame rate</span><span class="mmd-value">${FPS}</span><span class="mmd-unit">fps · fixed</span></label>
      <label title="Output width, in multiples of 32. The node's own widget, mirrored here."><span class="mmd-key">width</span><input class="s-width" type="number" min="32" step="32"></label>
      <label title="Output height, in multiples of 32. The node's own widget, mirrored here."><span class="mmd-key">height</span><input class="s-height" type="number" min="32" step="32"></label>
      <label title="How reference images are fitted. match scales them to the output size; max keeps them larger, which holds a face or a logo together better and costs more time."><span class="mmd-key">resize</span>
        <select class="s-ref">${["match", "max"].map((o) => `<option value="${o}">${o}</option>`).join("")}</select>
      </label>
      <span class="mmd-renders"></span>`;

    const frames = (input) => Math.max(0, Math.round(Number(input.value)));

    const bind = (selector, apply) => {
      const node = this.settings.querySelector(selector);
      node.onchange = () => { const next = this.read(); apply(next, node); this.commit(next); };
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); node.blur(); }
      });
    };

    // Typed lengths land on the lattice too: 144 is not a length H3 can render, and a box
    // reading 144 beside a clip that generates 158 is the same lie the timeline used to
    // tell. Zero stays zero -- that is "follow the content", not a length.
    bind(".s-duration", (next, node) => {
      const asked = frames(node);
      next.duration = asked ? snapUp(asked) : 0;
    });

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

  /** Cast cards drawn from this block's file whose feature moves onto somebody else. */
  transfersFrom(item) {
    const file = item.media?.filename;
    if (!file) return [];
    return (this.castOf?.()?.cards || []).filter(
      (card) => card.file === file && card.keep === "attribute_transfer");
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
    // On a camera block the move now has a chip of its own, so falling back to it here
    // would print the same word twice on one block.
    caption.textContent = item.prompt?.trim() || (track === "moves" ? "" : item.camera || "");
    node.appendChild(caption);

    // One strip along the bottom edge, because there are two kinds of thing to say about
    // a block's file and they used to be written in the same corner on top of each other:
    // which file it is, and what is lifted out of it and carried onto somebody else.
    const chips = [];
    // Words that will be *in* the picture, so they belong on the picture. Quoted, because
    // the quotes are what the model is sent and what makes this a sign rather than a note
    // to yourself. First in the strip: it is the block's own content, not a file it cites.
    if (String(item.screen_text || "").trim()) {
      chips.push({
        text: `"${item.screen_text.trim().replace(/^"|"$/g, "")}"`,
        className: "mmd-chip mmd-chip-text",
        title: "On-screen text: sent in double quotes, verbatim and untranslated",
      });
    }
    if (item.media?.filename) {
      chips.push({ text: `${item.media.kind.toUpperCase()} · ${item.media.filename}`,
                   className: "mmd-chip" });
    }
    for (const card of this.transfersFrom(item)) {
      chips.push({
        text: `${card.name || `S${card.id}`} → ${card.onto || "?"}`,
        className: `mmd-chip mmd-chip-move${card.onto ? "" : " mmd-chip-open"}`,
        title: card.onto
          ? `${card.description || "this person"} is transferred onto ${card.onto}`
          : "attribute_transfer with no target: say who receives it on the cast card",
      });
    }
    if (chips.length) {
      const strip = document.createElement("div");
      strip.className = "mmd-chips";
      for (const spec of chips) {
        const chip = document.createElement("span");
        chip.className = spec.className;
        chip.textContent = spec.text;
        if (spec.title) chip.title = spec.title;
        strip.appendChild(chip);
      }
      node.appendChild(strip);
    }

    // The move itself, on the block that plays it -- as the control, not a label of one.
    // It was only in the panel below, which meant reading the timeline told you a camera
    // block was there but never what it did, and a chip that turns into a dropdown when
    // clicked does not look like anything you can change.
    if (track === "moves") {
      const pick = document.createElement("select");
      pick.className = "mmd-cam-pick";
      pick.title = "The camera move for this block";
      pick.innerHTML = cameraOptions(item.camera);
      node.appendChild(pick);
    }

    // Same idea for a block carrying a file. Retention is the one field on an attachment
    // that changes what the model is told to do with it, and reading it off the timeline
    // beat opening the panel one block at a time to find the reference set to the wrong
    // marker. `describes` stays below: it is a sentence, not a choice.
    if (item.media) {
      const keep = document.createElement("select");
      keep.className = "mmd-keep-pick";
      keep.title = "How much of this file survives into the video";
      keep.innerHTML = retentionOptions(item.media.retention, item.media.kind);
      node.appendChild(keep);
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
    // Every path that changes what is selected ends up here, so this is the one place
    // that has to report it. See `remember()` in minimax_director.js for why anything
    // outside the editor cares.
    this.onState?.(this);

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

    // Two facts that add or remove controls rather than change their values: the first
    // shot is entered from nowhere so it has no transition, and a static camera has no
    // amplitude or speed. Folded into the shape below, or the control appears one
    // selection late.
    const first = track === "shots"
      && items(timeline, "shots").every((other) => other.start >= item.start);
    const still = item.camera === "static" ? 1 : 0;

    // Whether this render is showing a different segment than the last one. The focus
    // guards below exist so a render mid-keystroke does not eat what is being typed --
    // but when the selection itself changed, the field is about a different block and
    // keeping the old text is the bug, not the protection.
    const changed = this.panelShape !== `${track}:${index}:${item.media ? 1 : 0}:${this.speaks() ? 1 : 0}`
      + `:${first ? 1 : 0}:${still}`
      + `:${item.media?.subject?.trim() ? 1 : 0}`
      // How many rows, and which of them are a chorus: both change the markup, and a
      // shape that missed it left the new row unbuilt until the selection moved away.
      + `:${(item.lines?.length || 1)}`
      + `:${(item.lines || []).map((said) =>
            speakerNumbers(said.ids).length > 1 ? 1 : 0).join("")}`;

    this.segPrompt.disabled = false;
    if (changed || document.activeElement !== this.segPrompt) {
      this.segPrompt.value = item.prompt || "";
    }

    const end = item.end ?? item.start + item.length;
    this.range.textContent =
      `Start: ${item.start} f | End: ${end} f | Length: ${item.length} f` +
      ` = ${toSeconds(item.length).toFixed(2)}s`;

    // Only the CAMERA track. A shot used to carry one too, which meant the same sentence
    // could be written in two places -- inline on the shot's line, or in the Camera:
    // block -- with nothing on screen to say which you were getting.
    const cameras = track !== "moves" ? "" : `
      <label>camera
        <select class="mmd-f-camera">${cameraOptions(item.camera)}</select>
      </label>
      ${item.camera === "static" ? "" : `
      <label title="How far the framing travels. The guide leaves medium unwritten, so that option contributes nothing to the sentence -- which is what medium means.">amplitude
        <select class="mmd-f-amplitude">${
          scaleOptions(AMPLITUDES, item.amplitude, "medium")}</select>
      </label>
      <label title="How fast it travels. Normal is the unwritten default, for the same reason.">speed
        <select class="mmd-f-speed">${scaleOptions(SPEEDS, item.speed, "normal")}</select>
      </label>`}`;

    // MAIN blocks only, and the transition is hidden on the first shot: nothing is cut to
    // at the start of a clip, and offering a choice that compiles to nothing is a control
    // that lies about having an effect.
    const shotForm = track !== "shots" ? "" : `
      ${first ? "" : `
      <label title="How this shot is entered. An ordinary cut is what the guide asks for unless you want otherwise; cross-dissolve, fade and wipe are the three it allows on request.">enter with
        <select class="mmd-f-transition">${transitionOptions(item.transition)}</select>
      </label>`}
      <label class="mmd-f-wide" title="Words actually visible in frame: a sign, a banner, a label. Sent in double quotes, verbatim and untranslated -- the same service the dialogue row does for the spoken words.">on-screen text
        <input class="mmd-f-screen" type="text" placeholder="what a sign or banner reads, exactly"
               value="${String(item.screen_text || "").replace(/"/g, "&quot;")}">
      </label>`;

    // Only for a block carrying a file. Attaching one puts the clip in full-reference
    // mode, where the prompt has to say what each reference is and how much of it must
    // survive -- questions that have no meaning for a block with nothing attached.
    const subject = !item.media ? "" : `
      <label class="mmd-f-wide">describes
        <input class="mmd-f-subject" type="text" placeholder="what this file is, and what must stay the same"
               value="${String(item.media.description || "").replace(/"/g, "&quot;")}">
      </label>
      <label title="What this file is for. A frame anchor makes the clip a keyframe-completion task and is named as one in retention_analysis; a source video makes it a continuation or an edit. Everything else is guidance.">used as
        <select class="mmd-f-role">${roleOptions(item.media.role)}</select>
      </label>
      <label title="How much of this file survives into the video. Fixed values from MiniMax's own guide, and an audio file has a set of its own: fully_copy says this recording is the finished soundtrack, reference says only its timbre is followed. A cast card lifted out of this file carries its own marker for the person, which can differ.">keep file
        <select class="mmd-f-retention">${
          retentionOptions(item.media.retention, item.media.kind)}</select>
      </label>`;

    // MAIN blocks only. H3 generates the voice with the picture in one pass, and the
    // guide's form is exact enough that typing it by hand is how you get it wrong: the
    // words go inside `<d>` with a language tag and nothing else, everything about the
    // speaker stays outside it. A shot with two people talking gets a block each -- which
    // is what a timeline is for.
    const line = (track !== "shots" || !this.speaks()) ? "" : (() => {
      // One row per line, because two people in a shot usually say different things. Chips
      // lit together still mean a chorus -- the guide's (S1,S2), one sentence spoken by
      // both -- so the two readings stay separate: a chorus is one line, a conversation is
      // two. They compile in the order shown, which is the order they are heard in.
      const said = item.lines?.length ? item.lines : [{}];
      const row = (line, at) => {
        const value = (key, fallback = "") =>
          String(line[key] ?? fallback).replace(/"/g, "&quot;");
        return `
        <div class="mmd-f-line-row" data-line="${at}">
          <label class="mmd-f-wide" title="What is spoken during this shot. Sent verbatim -- never translated, punctuation kept.">line
            <input class="mmd-f-line" type="text" placeholder="the words, exactly as spoken" value="${value("text")}">
          </label>
          <div class="mmd-f-chips" title="Who says this line. Click a face; click two and they say it together, which is the guide's (S1,S2) form.">${
            this.chips(timeline, line.ids)}</div>
          <label title="How the line is performed. Becomes the verb in the sentence: says, whispers, shouts, answers -- anything you type, used as written.">how
            <input class="mmd-f-delivery" type="text" value="${value("delivery", "says")}">
          </label>
          <label title="Names the language of the words. The words themselves are never translated.">language
            <input class="mmd-f-language" type="text" value="${value("language", "English")}">
          </label>
          <label class="mmd-switch" title="A voiceover: heard, not seen being spoken. Writes the guide's exact phrase and the clause it requires after every one -- that the character's lips stay closed. Without the second half the model animates a mouth to match.">
            <input class="mmd-f-offscreen" type="checkbox"${line.offscreen ? " checked" : ""}> off-screen
          </label>
          <label class="mmd-switch" title="This line does not finish inside this block. Compiles as <scenetrans> at both sides of the cut with a continuity phrase, or as <cutoff> when the clip simply ends underneath it.">
            <input class="mmd-f-carries" type="checkbox"${line.carries ? " checked" : ""}> carries over
          </label>
          ${said.length > 1
            ? '<button class="mmd-f-delline" title="Remove this line">×</button>' : ""}
        </div>`;
      };
      return `<div class="mmd-f-lines">${said.map(row).join("")}
        <button class="mmd-f-addline" title="Another line in this shot -- somebody else, or the same person answering">+ line</button>
      </div>`;
    })();

    const patch = (change) => {
      const next = this.read();
      Object.assign(items(next, track)[index], change);
      this.commit(next);
    };

    /** Write one field of one of the block's lines, keeping the rest. */
    const patchLine = (change, live = false, at = 0) => {
      const next = this.read();
      const target = items(next, track)[index];
      if (!target) return;
      const lines = [...(target.lines || [])];
      const said = { ids: "S1", delivery: "says", language: "English", text: "",
                     ...(lines[at] || {}), ...change };

      // Dropped only when nothing has been said *and* nothing has been decided. Keying it
      // on the words alone meant picking a speaker or describing a voice before typing the
      // line was silently discarded -- the control moved and the document did not.
      // The compiler still ignores a line with no words, so a half-filled row cannot reach
      // the prompt; it just survives long enough to be finished.
      const blank = !said.text.trim() && !String(said.speaker || "").trim()
        && speakerNumbers(said.ids).join() === "1"
        && !said.offscreen && !said.carries
        && said.delivery === "says" && said.language === "English";
      // Only the last row may vanish for being empty. An empty row above a full one is a
      // line the author is still writing, and dropping it would renumber the rest under
      // the cursor.
      lines[at] = said;
      target.lines = blank && at === lines.length - 1 ? lines.slice(0, at) : lines;
      if (!live) return this.commit(next);
      this.snapshotTyping();
      this.write(next);
    };

    /** Write onto the attachment record rather than the block itself. */
    const patchMedia = (change, live = false) => {
      const next = this.read();
      const target = items(next, track)[index];
      if (!target?.media) return;
      target.media = { ...target.media, ...change };
      if (!live) return this.commit(next);
      this.snapshotTyping();
      this.write(next);
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
      stretchFor(next, target);
      this.write(next);
      this.render();
    };

    // Rebuilding the markup on every render would destroy whatever is being typed, so
    // it happens only when the panel is actually a different shape. Everything else is
    // an in-place value update below.
    const shape = `${track}:${index}:${item.media ? 1 : 0}:${this.speaks() ? 1 : 0}`
      + `:${first ? 1 : 0}:${still}`
      + `:${item.media?.subject?.trim() ? 1 : 0}`
      // How many rows, and which of them are a chorus: both change the markup, and a
      // shape that missed it left the new row unbuilt until the selection moved away.
      + `:${(item.lines?.length || 1)}`
      + `:${(item.lines || []).map((said) =>
            speakerNumbers(said.ids).length > 1 ? 1 : 0).join("")}`;
    if (this.panelShape !== shape) {
      this.panelShape = shape;
      // Three groups on three rows: when a block moves, what is said in it, and what
      // file it carries. Eleven controls in one wrapping row read as one list of eleven
      // unrelated things, and the row broke wherever the width happened to run out.
      const group = (tag, body) =>
        !body.trim() ? "" : `<div class="mmd-f-group"><span class="mmd-f-tag">${tag}</span>${body}</div>`;

      this.segFields.innerHTML = group("timing", `
        <label title="The first frame of this block -- frames are the unit the document stores.">start <input class="mmd-f-start" type="number" min="0" step="1"><span class="mmd-unit">f</span></label>
        <label class="mmd-f-locked" title="The same instant in seconds. Read-only: frames are what H3 is given, and a rounded second typed back would move the block."><span class="mmd-key">=</span><span class="mmd-mirror mmd-f-start-secs"></span><span class="mmd-unit">s</span></label>
        <label title="The frame this block ends on. Editing it moves the end, not the start -- the same as dragging the right grip.">end <input class="mmd-f-end" type="number" min="1" step="1"><span class="mmd-unit">f</span></label>
        <label class="mmd-f-locked" title="The end in seconds. Read-only."><span class="mmd-key">=</span><span class="mmd-mirror mmd-f-end-secs"></span><span class="mmd-unit">s</span></label>
        <label title="How long this block runs, in frames.">length <input class="mmd-f-len" type="number" min="1" step="1"><span class="mmd-unit">f</span></label>
        <label class="mmd-f-locked" title="The same length in seconds. Read-only."><span class="mmd-key">=</span><span class="mmd-mirror mmd-f-secs"></span><span class="mmd-unit">s</span></label>`)
        + group("shot", shotForm)
        + group("camera", cameras)
        + group("file", subject
            + (item.media ? '<button class="mmd-f-unlink">detach media</button>' : ""))
        // Last, because it is the longest row and the only one that is usually absent --
        // and because the cast it draws from sits directly below the panel.
        + group("dialogue", line);

      const secsEl = this.segFields.querySelector(".mmd-f-secs");
      const lenEl = this.segFields.querySelector(".mmd-f-len");
      const startEl = this.segFields.querySelector(".mmd-f-start");
      const startSecsEl = this.segFields.querySelector(".mmd-f-start-secs");
      const endEl = this.segFields.querySelector(".mmd-f-end");
      const endSecsEl = this.segFields.querySelector(".mmd-f-end-secs");

      // Start, end and length are three readings of two numbers, so editing any one of
      // them has to move the other two on screen. Only the box under the cursor is left
      // alone -- writing into it is what eats keystrokes.
      const mirror = (start, len) => {
        startSecsEl.textContent = toSeconds(start).toFixed(2);
        secsEl.textContent = toSeconds(len).toFixed(2);
        endSecsEl.textContent = toSeconds(start + len).toFixed(2);
        if (endEl !== document.activeElement) endEl.value = start + len;
      };

      // Frames are typed, seconds are shown. They were both editable, and a second is
      // 24 frames wide -- so a block typed as `1.08` came back as 26 frames, redisplayed
      // as `1.08`, and the number the author actually set was never on screen. The clip
      // is written in seconds; it is *cut* in frames, and only one of those can be the
      // field you edit.
      //
      // The same ceiling the drag obeys: typing a length may not push past a neighbour,
      // or the two ways of editing would disagree about what is legal.
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
        if (n !== wanted || lenEl !== document.activeElement) lenEl.value = n;
        mirror(here.start, n);
        patchLive({ length: n });
      };

      // A number input reports "" for anything half-typed -- "2." is not a number yet.
      // Treating that as zero clamped the block to one frame and then wrote the result
      // back over the field, so "2.5" came out as "0.045".
      const typed = (el) => (el.value.trim() === "" ? null : Number(el.value));

      lenEl.addEventListener("input", () => {
        const value = typed(lenEl);
        if (value !== null && Number.isFinite(value)) setLength(value);
      });

      // Typing an end moves the end. Reading it as "keep the length, slide the block" is
      // the other possible answer and the wrong one: the right grip does exactly this,
      // and two controls that look like the same edit must not do different things.
      const setEnd = (frames) => {
        const now = this.read();
        const here = items(now, track)[index] || item;
        setLength(Math.round(frames) - here.start);
      };

      endEl.addEventListener("input", () => {
        const value = typed(endEl);
        if (value !== null && Number.isFinite(value)) setEnd(value);
      });

      // Frames typed, seconds shown -- the same bargain the length fields make.
      const setStart = (frames) => {
        const now = this.read();
        const here = items(now, track)[index] || item;
        const [floor, roof] = neighbours(now, track, index);
        const top = Math.max(floor, roof - here.length);
        const wanted = Math.round(frames);
        const start = Math.max(floor, Math.min(wanted, top));

        if (start !== wanted || startEl !== document.activeElement) startEl.value = start;
        mirror(start, here.length);
        patchLive({ start });
      };

      startEl.addEventListener("input", () => {
        const value = typed(startEl);
        if (value !== null && Number.isFinite(value)) setStart(value);
      });
      // Delegated, because how many rows there are is the document's business and not
      // this listener's: one handler covers the row that exists now and the one added
      // next. `data-line` on the row is which line the control belongs to.
      const rowOf = (target) => Number(target.closest(".mmd-f-line-row")?.dataset.line ?? 0);
      const lines = this.segFields.querySelector(".mmd-f-lines");

      for (const [selector, key] of [
        [".mmd-f-line", "text"],
        [".mmd-f-delivery", "delivery"], [".mmd-f-language", "language"],
      ]) {
        lines?.addEventListener("input", (e) => {
          if (!e.target.matches(selector)) return;
          if (key === "text") {
            const row = e.target.closest(".mmd-f-line-row");
            row?.classList.toggle("mmd-f-quiet", !e.target.value.trim());
            row?.closest(".mmd-f-group")?.classList.toggle(
              "mmd-f-quiet",
              ![...(row?.closest(".mmd-f-lines")?.querySelectorAll(".mmd-f-line") || [])]
                .some((box) => box.value.trim()));
          }
          patchLine({ [key]: e.target.value }, true, rowOf(e.target));
        });
      }

      // The two switches on a row. `change` rather than `input`, because a checkbox has
      // one and only one of those worth acting on, and both fire.
      lines?.addEventListener("change", (e) => {
        for (const [selector, key] of [
          [".mmd-f-offscreen", "offscreen"], [".mmd-f-carries", "carries"],
        ]) {
          if (!e.target.matches(selector)) continue;
          patchLine({ [key]: e.target.checked }, false, rowOf(e.target));
        }
      });

      // Clicking a face adds or removes that person from that line. A chorus is two chips
      // lit at once, so the group form needs no mode of its own; the last one cannot be
      // turned off, because a line spoken by nobody is not a line.
      lines?.addEventListener("click", (e) => {
        if (e.target.closest(".mmd-f-tocast")) return this.showTab("cast");

        if (e.target.closest(".mmd-f-addline")) {
          const next = this.read();
          const target = items(next, track)[index];
          if (!target) return;
          target.lines = [...(target.lines || []),
                          { ids: "S1", delivery: "says", language: "English", text: "" }];
          this.panelShape = null;
          return this.commit(next);
        }

        if (e.target.closest(".mmd-f-delline")) {
          const at = rowOf(e.target);
          const next = this.read();
          const target = items(next, track)[index];
          if (!target) return;
          target.lines = (target.lines || []).filter((_, i) => i !== at);
          this.panelShape = null;
          return this.commit(next);
        }

        const chip = e.target.closest(".mmd-f-chip");
        if (!chip) return;
        const at = rowOf(chip);
        const who = Number(chip.dataset.speaker);
        const current = speakerNumbers(items(this.read(), track)[index]?.lines?.[at]?.ids);
        const next = current.includes(who)
          ? current.filter((number) => number !== who)
          : [...current, who].sort((a, b) => a - b);
        if (!next.length) return;
        patchLine({ ids: speakerIds(next) }, false, at);
        this.panelShape = null;
        this.render();
      });
      // A change of motion can add or remove the two dynamics pickers, so the panel is
      // rebuilt rather than repainted -- `patch` alone would leave the old pair on screen
      // beside a camera that no longer has them.
      this.segFields.querySelector(".mmd-f-camera")
        ?.addEventListener("change", (e) => {
          this.panelShape = null;
          patch({ camera: e.target.value });
        });
      this.segFields.querySelector(".mmd-f-amplitude")
        ?.addEventListener("change", (e) => patch({ amplitude: e.target.value }));
      this.segFields.querySelector(".mmd-f-speed")
        ?.addEventListener("change", (e) => patch({ speed: e.target.value }));
      this.segFields.querySelector(".mmd-f-transition")
        ?.addEventListener("change", (e) => patch({ transition: e.target.value }));
      this.segFields.querySelector(".mmd-f-screen")
        ?.addEventListener("input", (e) => {
          this.snapshotTyping();
          const next = this.read();
          items(next, track)[index].screen_text = e.target.value;
          this.write(next);
          // The chip on the block is the only place this text is visible while you are
          // looking at the timeline, so it follows the keystroke. `render` puts the caret
          // back; the panel itself is not rebuilt, because its shape has not changed.
          this.render();
        });
      this.segFields.querySelector(".mmd-f-subject")
        ?.addEventListener("input", (e) => patchMedia({ description: e.target.value }, true));
      this.segFields.querySelector(".mmd-f-retention")
        ?.addEventListener("change", (e) => patchMedia({ retention: e.target.value }));
      this.segFields.querySelector(".mmd-f-role")
        ?.addEventListener("change", (e) => patchMedia({ role: e.target.value }));
      this.segFields.querySelector(".mmd-f-unlink")
        ?.addEventListener("click", () => {
          const next = this.read();
          delete items(next, track)[index].media;
          this.panelShape = null;
          this.commit(next);
        });
    }

    // Never write into the field under the cursor -- that is what eats keystrokes. The
    // exception is a render that switched segments: the field now describes a different
    // block, so holding the old number is worse than moving the caret.
    const put = (selector, value) => {
      const el = this.segFields.querySelector(selector);
      if (el && (changed || el !== document.activeElement)) el.value = value;
    };
    put(".mmd-f-start", item.start);
    put(".mmd-f-end", item.start + item.length);
    put(".mmd-f-len", item.length);
    put(".mmd-f-camera", item.camera || "static");
    put(".mmd-f-amplitude", item.amplitude || "");
    put(".mmd-f-speed", item.speed || "");
    put(".mmd-f-transition", item.transition || "cut");
    put(".mmd-f-screen", item.screen_text || "");

    // Undo and a switch of selection both land here; the rows themselves are built once.
    const rows = [...this.segFields.querySelectorAll(".mmd-f-line-row")];
    rows.forEach((row, at) => {
      const said = item.lines?.[at] || {};
      const write = (selector, value) => {
        const el = row.querySelector(selector);
        if (el && (changed || el !== document.activeElement)) el.value = value;
      };
      write(".mmd-f-line", said.text ?? "");
      // Nothing said yet, nothing to say it about: the speaker, the delivery and the
      // language are dimmed until there are words for them to describe.
      row.classList.toggle("mmd-f-quiet", !String(said.text ?? "").trim());
      // And the group's own surface, once every row in it is empty: a box that holds
      // nothing should not look like a box that holds something.
      row.closest(".mmd-f-group")?.classList.toggle(
        "mmd-f-quiet", !(item.lines || []).some((line) => String(line.text || "").trim()));
      write(".mmd-f-delivery", said.delivery ?? "says");
      write(".mmd-f-language", said.language ?? "English");
      // Checkboxes hold no caret, so they follow the document unconditionally -- which is
      // what makes undo put them back.
      for (const [selector, on] of [
        [".mmd-f-offscreen", said.offscreen === true],
        [".mmd-f-carries", said.carries === true],
      ]) {
        const box = row.querySelector(selector);
        if (box) box.checked = on;
      }
    });
    // The chips carry names and faces owned by the cast, so they go stale as the cast is
    // edited. Rebuilt on every render: they hold no caret to lose.
    this.paintPicker(timeline);

    // The locked mirrors are never the field under the cursor, so they follow every
    // render unconditionally -- `put`'s focus guard has nothing to protect here.
    const show = (selector, value) => {
      const el = this.segFields.querySelector(selector);
      if (el) el.textContent = value;
    };
    show(".mmd-f-start-secs", toSeconds(item.start).toFixed(2));
    show(".mmd-f-end-secs", toSeconds(item.start + item.length).toFixed(2));
    show(".mmd-f-secs", toSeconds(item.length).toFixed(2));
  }
}
