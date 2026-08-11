/**
 * The cast, on a node of its own.
 *
 * A character is four things -- a face, a name, a description the model has to honour and
 * a voice -- and in the director they were authored in two different places with nothing
 * on screen tying them together. Here they are one card, and the compiler takes them apart
 * again (`cast.py`) into the subject records and speakers the prompt format wants.
 *
 * This node reads the director's timeline but never writes to it. The card names the file
 * it draws somebody out of by *filename*: `<Picture 2>` is computed from where blocks sit
 * and changes the moment one is dragged, which would silently re-point a card at a
 * different photograph.
 */

import { install } from "./styles.js";
import * as media from "./media.js";
import { RETENTIONS, filesOf } from "./model.js";
import { BUILD } from "../build.js";

export const EMPTY = { version: 1, speech: true, cards: [] };

/** A tag that survives renumbering: the pairing the compiler resolves. */
const uid = () => Math.random().toString(36).slice(2, 9);

export function parseCast(text) {
  try {
    const document = JSON.parse(text || "{}");
    if (!document || typeof document !== "object") return { ...EMPTY };
    return {
      version: 1,
      speech: document.speech !== false,
      cards: (Array.isArray(document.cards) ? document.cards : [])
        .filter((card) => card && typeof card === "object")
        .map((card, position) => ({
          id: Number(card.id) || position + 1,
          uid: String(card.uid || ""),
          name: String(card.name || ""),
          file: String(card.file || ""),
          description: String(card.description || ""),
          keep: String(card.keep || ""),
          voice: String(card.voice || ""),
        })),
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Which `<Subject n>` each card is, mirroring `cast.merge` followed by
 * `attachments.subjects`: files in reference order, and within a file the order the cards
 * were written. A card with no description defines nothing and takes no number.
 */
export function numbering(timeline, cards) {
  const numbers = new Map();
  if (!timeline) return numbers;
  let next = 1;
  for (const file of filesOf(timeline)) {
    for (const card of cards) {
      if (card.file !== (file.media.filename || "") || !card.description.trim()) continue;
      numbers.set(card.uid || card.id, next);
      next += 1;
    }
  }
  return numbers;
}

const retentionOptions = (current) => {
  const value = current || RETENTIONS[0];
  return RETENTIONS
    .map((name) => `<option value="${name}"${name === value ? " selected" : ""}>${name}</option>`)
    .join("");
};

export class CastEditor {
  /**
   * @param {() => object} read   parse this node's own JSON widget
   * @param {(c: object) => void} write  serialise it back
   * @param {() => object|null} timeline  the connected director's timeline, or null
   */
  constructor(read, write, timeline) {
    install();
    this.read = read;
    this.write = write;
    this.timeline = timeline;
    this.shape = null;

    this.root = document.createElement("div");
    this.root.className = "mmd mmd-cast-node";
    this.root.innerHTML = `
      <div class="mmd-prompt mmd-cast-box">
        <label>CAST
          <span class="mmd-hint">everyone in this clip — one card each: their face, what stays the same, how they sound</span>
        </label>
        <textarea class="mmd-cast-grip" readonly tabindex="-1" title="Drag to resize the cast"></textarea>
        <div class="mmd-cast-body">
          <div class="mmd-cast"></div>
          <div class="mmd-cast-foot">
            <button class="mmd-cast-add" title="A card for one person. Drawn from a file on the director's timeline if there is one, so the picture and the voice are known to be the same person.">+ character</button>
            <label class="mmd-switch" title="Off, nobody speaks: the voices go away and nothing spoken is compiled. The cards stay -- a character can be in a clip without saying anything.">
              <input class="mmd-speech" type="checkbox"> they speak
            </label>
            <span class="mmd-grow"></span>
            <span class="mmd-stamp">${BUILD}</span>
          </div>
        </div>
      </div>`;

    this.list = this.root.querySelector(".mmd-cast");
    this.speech = this.root.querySelector(".mmd-speech");
    this.box = this.root.querySelector(".mmd-cast-box");
    this.grip();

    this.speech.addEventListener("change", () => {
      const next = this.read();
      next.speech = this.speech.checked;
      this.commit(next);
    });
    this.root.querySelector(".mmd-cast-add")
      .addEventListener("click", () => this.addCharacter());

    this.list.addEventListener("input", (event) => {
      const card = event.target.closest("[data-card]");
      if (!card) return;
      const key = ["name", "description", "voice"]
        .find((name) => event.target.classList.contains(`mmd-card-${name}`));
      if (key) this.patch(Number(card.dataset.card), { [key]: event.target.value }, true);
    });
    this.list.addEventListener("change", (event) => {
      const card = event.target.closest("[data-card]");
      if (!card) return;
      const position = Number(card.dataset.card);
      if (event.target.classList.contains("mmd-card-retention")) {
        this.patch(position, { keep: event.target.value });
      } else if (event.target.classList.contains("mmd-card-file")) {
        this.patch(position, { file: event.target.value });
      }
    });
    this.list.addEventListener("click", (event) => {
      const card = event.target.closest("[data-card]");
      if (card && event.target.closest(".mmd-cast-drop")) {
        this.drop(Number(card.dataset.card));
      }
    });
  }

  /** Called by the host after every write, so the director recompiles its preview. */
  onChange = null;
  /** Called after every render, so the node can shrink to the cast it now holds. */
  onResize = null;

  commit(state) {
    this.write(state);
    this.shape = null;
    this.render();
    this.onChange?.();
  }

  patch(position, change, live = false) {
    const state = this.read();
    const card = state.cards[position];
    if (!card) return;
    state.cards[position] = { ...card, ...change };
    this.write(state);
    if (live) {
      // Not a rebuild: the caret is in one of these boxes. Only the numbers move.
      this.paint(state);
      this.onChange?.();
      return;
    }
    this.commit(state);
  }

  addCharacter() {
    const state = this.read();
    const first = filesOf(this.timeline() || {})[0];
    const number = Math.max(0, ...state.cards.map((card) => card.id)) + 1;
    state.cards.push({
      id: number,
      uid: uid(),
      name: "",
      file: first ? first.media.filename || "" : "",
      description: "",
      keep: "",
      voice: "",
    });
    this.commit(state);
    this.list.querySelector(`[data-card="${state.cards.length - 1}"] .mmd-card-name`)
      ?.focus();
  }

  drop(position) {
    const state = this.read();
    const card = state.cards[position];
    if (card && (card.name.trim() || card.description.trim() || card.voice.trim())
        && !confirm(`Remove ${card.name.trim() || "this character"} from the cast?`)) {
      return;
    }
    state.cards.splice(position, 1);
    this.commit(state);
  }

  /** A person's face: the file they were drawn from, at thumbnail size. */
  face(card, file) {
    const src = file ? media.url(file.media) : null;
    if (!src) return `<span class="mmd-face mmd-face-none">?</span>`;
    if (file.media.kind === "video") {
      return `<video class="mmd-face" src="${src}#t=0.6" muted preload="metadata"></video>`;
    }
    return `<span class="mmd-face" style="background-image:url('${src}')"></span>`;
  }

  /**
   * Drag the block taller by the corner.
   *
   * Ours rather than CSS `resize`, which Chrome answers with a glyph of its own that no
   * rule reliably hides -- next to the one drawn to match the prompt boxes it read as two
   * handles in one corner. The pointer moves in screen pixels and the editor lives inside
   * the canvas's transform, so the movement is divided by whatever that scale turns out to
   * be, measured rather than looked up.
   */
  grip() {
    const grip = this.root.querySelector(".mmd-cast-grip");
    if (!grip) return;
    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      grip.setPointerCapture(event.pointerId);
      const start = event.clientY;
      const from = this.box.offsetHeight;
      const scale = (this.box.getBoundingClientRect().height / from) || 1;

      const move = (moved) => {
        const height = Math.max(120, from + (moved.clientY - start) / scale);
        this.box.style.height = `${Math.round(height)}px`;
      };
      const done = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", done);
        grip.removeEventListener("pointercancel", done);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", done);
      grip.addEventListener("pointercancel", done);
    });
  }

  render() {
    const state = this.read();
    const timeline = this.timeline();
    const files = filesOf(timeline || {});
    const numbers = numbering(timeline, state.cards);

    this.speech.checked = state.speech !== false;
    this.box.classList.toggle("mmd-off", state.speech === false);

    // Rebuilt only when the list itself changed, or a caret would be taken out of the box
    // being typed into on every keystroke.
    const shape = state.cards.map((card) => `${card.id}/${card.file}`).join(",")
      + `|${files.map((file) => file.token + file.media.filename).join("|")}`
      + `|${timeline ? "" : "none"}`;

    if (this.shape !== shape) {
      this.shape = shape;
      this.list.innerHTML = state.cards.map((card, position) => {
        const file = files.find((item) => (item.media.filename || "") === card.file) || null;
        const value = (text) => String(text || "").replace(/"/g, "&quot;");
        const index = numbers.get(card.uid || card.id) || 0;

        return `
        <div class="mmd-card" data-card="${position}">
          ${this.face(card, file)}
          <div class="mmd-card-body">
            <div class="mmd-card-top">
              <input class="mmd-card-name" type="text" placeholder="name them: WOMAN"
                     value="${value(card.name)}">
              <span class="mmd-card-badge" title="The speaker ID the prompt uses">S${card.id}</span>
              <span class="mmd-card-badge mmd-card-subject${index ? "" : " mmd-hide"}"
                    title="What the prompt calls this person, computed from where their file sits on the director's timeline">&lt;Subject ${index}&gt;</span>
              <label class="mmd-card-from" title="Which file on the director's timeline this person is drawn from. Two people out of one photograph is two cards pointing at the same file.">from
                <select class="mmd-card-file">
                  <option value=""${file ? "" : " selected"}>— words only, no file</option>
                  ${files.map((item) => `
                  <option value="${value(item.media.filename)}"${item === file ? " selected" : ""}
                    >${item.token.replace("<", "&lt;")} ${item.media.filename || ""}</option>`).join("")}
                </select>
              </label>
              ${!file ? "" : `
              <label class="mmd-card-keep" title="How much of this person survives into the video. attribute_transfer carries a feature onto somebody else; fully_preserved keeps them as they are.">keep
                <select class="mmd-card-retention">${retentionOptions(card.keep)}</select>
              </label>`}
              <span class="mmd-grow"></span>
              <button class="mmd-cast-drop" title="Remove from the cast">✕</button>
            </div>
            ${!file ? "" : `
            <input class="mmd-card-description" type="text"
                   placeholder="what they look like, and what must stay the same"
                   value="${value(card.description)}">`}
            <input class="mmd-card-voice" type="text"
                   placeholder="how they sound: age, gender, pitch, timbre, accent"
                   value="${value(card.voice)}">
          </div>
        </div>`;
      }).join("") || (timeline
        ? `<div class="mmd-cast-empty">Nobody yet. Add a character, then say what they
             look like and how they sound.</div>`
        : `<div class="mmd-cast-empty">Not connected. Wire this node's <b>cast</b> output
             into the director, and the files on its timeline appear here.</div>`);
    } else {
      this.paint(state, numbers);
    }

    // A card taller or shorter than the node it sits in is the whole reason this node was
    // split out, so the height follows the list on every render rather than on a gesture.
    requestAnimationFrame(() => this.onResize?.());
  }

  /** Values and numbers, for a list whose shape has not changed. */
  paint(state, numbers = null) {
    const marks = numbers || numbering(this.timeline(), state.cards);
    state.cards.forEach((card, position) => {
      const row = this.list.querySelector(`[data-card="${position}"]`);
      if (!row) return;

      const badge = row.querySelector(".mmd-card-subject");
      if (badge) {
        const index = marks.get(card.uid || card.id) || 0;
        badge.textContent = `<Subject ${index}>`;
        badge.classList.toggle("mmd-hide", !index);
      }
      for (const [selector, text] of [
        [".mmd-card-name", card.name],
        [".mmd-card-description", card.description],
        [".mmd-card-voice", card.voice],
      ]) {
        const box = row.querySelector(selector);
        if (box && box !== document.activeElement) box.value = String(text || "");
      }
    });
  }
}
