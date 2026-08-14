/**
 * The cast, on a node of its own.
 *
 * A card is one *subject*: the thing the prompt will call `<Subject n>`. Usually a person
 * -- a face, a name, a description the model has to honour and a voice, which in the
 * director were authored in two different places with nothing on screen tying them
 * together -- but the guide's subjects are not only people. A costume, a prop, a place or
 * a style lifted out of the same photograph is a subject too, with a retention marker of
 * its own, and it fills in the same card leaving the voice row empty. Here they are one
 * card, and the compiler takes them apart again (`cast.py`) into the subject records and
 * speakers the prompt format wants.
 *
 * This node reads the director's timeline but never writes to it. The card names the file
 * it draws somebody out of by *filename*: `<Picture 2>` is computed from where blocks sit
 * and changes the moment one is dragged, which would silently re-point a card at a
 * different photograph.
 */

import { install } from "./styles.js";
import * as media from "./media.js";
import { RETENTIONS, audioOf, filesOf, items, speakerNumbers } from "./model.js";
import { BUILD } from "../build.js";
import { ICON } from "./icons.js";

export const EMPTY = { version: 1, speech: true, cards: [] };

/** User text into markup. The tokens this editor prints are literally `<Picture 1>`. */
const text = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
          // Never blank. The select shows the first marker when the value is empty, while
          // the compiler reads an empty subject marker as "retain this person the way the
          // file they came from is retained" -- so a card reading `fully_preserved` beside
          // a `weak_reference` photo compiled as `weak_reference`. What is displayed is
          // what is stored.
          keep: String(card.keep || RETENTIONS[0]),
          onto: String(card.onto || ""),
          voice: String(card.voice || ""),
          // A second asset for the same person, and a third: the guide allows one subject
          // to be defined by several files, each supplying a different thing. A still says
          // what somebody looks like and can say nothing about how they move or sound.
          motion_from: String(card.motion_from || ""),
          voice_from: String(card.voice_from || ""),
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
        <label>WHO &amp; WHAT
          <span class="mmd-hint">everyone and everything the prompt has to name — people, props, costumes, places: one card each, and each is where its file is described</span>
        </label>
        <div class="mmd-cast-legend">
          <span><b>S1…Sn</b> a <b>speaker</b> — who says a line. Any card with a voice.
            The words themselves go on a shot's dialogue row.</span>
          <span><b>&lt;Subject 1…n&gt;</b> a <b>subject</b> — a person, a costume, a prop,
            a place, a look the model must keep. A card is one only with a file
            <i>and</i> a description; without a file it can only be a voice.</span>
        </div>
        <textarea class="mmd-cast-grip" readonly tabindex="-1" title="Drag to resize the list"></textarea>
        <div class="mmd-cast-body">
          <div class="mmd-cast"></div>
          <div class="mmd-cast-foot">
            <button class="mmd-cast-add" title="A card for one subject -- a person, but equally a costume, a prop, a place or a style. Drawn from a file on the director's timeline if there is one, so the picture and the voice are known to be the same subject. Several cards may point at the same file: that is how one photograph names several things.">Add</button>
            <label class="mmd-switch" title="The dialogue switch for the whole clip. Off, nobody speaks: every DIALOGUE row goes off the blocks and every <d> goes out of the prompt, in one press. The cards stay -- a card can be in a clip without saying anything, and most of them never do.">
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
      .addEventListener("click", () => this.addSubject());

    this.list.addEventListener("input", (event) => {
      const card = event.target.closest("[data-card]");
      if (!card) return;
      const key = ["name", "description", "voice", "onto"]
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
      } else if (event.target.classList.contains("mmd-card-motion")) {
        this.patch(position, { motion_from: event.target.value });
      } else if (event.target.classList.contains("mmd-card-voice-from")) {
        this.patch(position, { voice_from: event.target.value });
      } else if (event.target.classList.contains("mmd-card-onto-pick")) {
        const chosen = event.target.value;
        event.target.value = "";
        if (chosen) this.patch(position, { onto: chosen });
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

  /**
   * A new card, optionally bound to a file already.
   *
   * The FILE row on a block calls this with its own filename: a picture with three people
   * in it needs three cards pointed at it, and walking over to this tab and picking the
   * same file out of a select three times is the long way round to say so.
   */
  addSubject(file = null) {
    const state = this.read();
    const first = filesOf(this.timeline() || {})[0];
    const number = Math.max(0, ...state.cards.map((card) => card.id)) + 1;
    state.cards.push({
      id: number,
      uid: uid(),
      name: "",
      file: file ?? (first ? first.media.filename || "" : ""),
      description: "",
      keep: RETENTIONS[0],
      onto: "",
      voice: "",
      motion_from: "",
      voice_from: "",
    });
    this.commit(state);
    // A frame later: the row does not exist until the commit has been rendered, and when
    // the card was made from a block's FILE row the tab it lives on was hidden until the
    // click that got here.
    requestAnimationFrame(() => {
      const box = this.list
        .querySelector(`[data-card="${state.cards.length - 1}"] .mmd-card-name`);
      box?.focus();
      box?.scrollIntoView({ block: "nearest" });
    });
  }

  drop(position) {
    const state = this.read();
    const card = state.cards[position];
    if (card && (card.name.trim() || card.description.trim() || card.voice.trim())
        && !confirm(`Remove ${card.name.trim() || "this card"} from the cast?`)) {
      return;
    }
    state.cards.splice(position, 1);
    this.commit(state);
  }

  /**
   * Every card gone, and `they speak` back on.
   *
   * The toolbar's Clear empties the piece, not the tab that happens to be open: cards
   * describe files that are no longer on the timeline, so leaving them behind leaves a
   * list of subjects pointed at nothing. Its own confirm has already been answered.
   */
  clear() {
    this.commit({ ...EMPTY, cards: [] });
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
        // The one place a list height is authored, besides the node's own corner. The
        // host stores it on the node, so it comes back with the workflow.
        this.onBoxHeight?.(Math.round(height));
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
    // A person's motion can only come from something that moves, and their timbre only
    // from something audible -- so the two extra pickers are drawn from their own lists
    // rather than from every file on the timeline.
    const clips = files.filter((file) => file.media.kind === "video");
    const heard = audioOf(timeline || {});
    const numbers = numbering(timeline, state.cards);

    this.speech.checked = state.speech !== false;
    this.box.classList.toggle("mmd-off", state.speech === false);

    // Rebuilt only when the list itself changed, or a caret would be taken out of the box
    // being typed into on every keystroke.
    const shape = state.cards
      .map((card) => `${card.id}/${card.file}/${card.keep}/${card.motion_from}/${card.voice_from}`)
      .join(",")
      + `|${files.map((file) => file.token + file.media.filename).join("|")}`
      + `|${heard.map((file) => file.token + file.media.filename).join("|")}`
      + `|${timeline ? "" : "none"}`
      // The `onto` suggestions are the other cards and the shots, so a rename or a
      // reworded shot has to reach the list rather than waiting for the next rebuild.
      + `|${state.cards.map((card) => card.name).join("/")}`
      + `|${(timeline?.shots || []).map((shot) => (shot.prompt || "").slice(0, 24)).join("/")}`;

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
              <input class="mmd-card-name" type="text" placeholder="name it: WOMAN, COAT"
                     value="${value(card.name)}">
              <span class="mmd-card-badge" title="The speaker ID the prompt uses">S${card.id}</span>
              <span class="mmd-card-badge mmd-card-subject${index ? "" : " mmd-hide"}"
                    title="What the prompt calls this subject, computed from where its file sits on the director's timeline">&lt;Subject ${index}&gt;</span>
              <span class="mmd-card-badge mmd-card-nosubject${index ? " mmd-hide" : ""}"
                    title="No file, so there is nothing on screen for the model to look at and keep. This card is a speaker and nothing else. Pick a file in from to give it a <Subject n>.">no &lt;Subject&gt;</span>
              <span class="mmd-card-badge mmd-card-heard mmd-hide"
                    title="Which shots this card is heard in. Set on the TIMELINE tab, by ticking this face on a shot's dialogue row -- the words belong to a shot, not to a person."></span>
              <label class="mmd-card-from" title="Which file on the director's timeline this subject is drawn from. Several things out of one photograph -- a person, their coat, the room behind them -- is several cards pointing at the same file, each numbered separately.">from
                <select class="mmd-card-file">
                  <option value=""${file ? "" : " selected"}>— no file</option>
                  ${files.map((item) => `
                  <option value="${value(item.media.filename)}"${item === file ? " selected" : ""}
                    >${item.token.replace("<", "&lt;")} ${item.media.filename || ""}</option>`).join("")}
                </select>
              </label>
              ${!file ? "" : `
              <label class="mmd-card-keep" title="How much of this subject survives into the video -- its own marker, not the file's: the photo may be fully_preserved while the face taken from it is an attribute_transfer onto somebody else. Compiled as subject_retention.">keep it
                <select class="mmd-card-retention">${retentionOptions(card.keep)}</select>
              </label>
              ${!clips.length ? "" : `
              <label class="mmd-card-from" title="A second file for the same subject, supplying how it moves rather than what it looks like. The guide allows one subject to be defined by several assets, each with a job of its own -- a still cannot say anything about a walk.">motion from
                <select class="mmd-card-motion">
                  <option value=""${card.motion_from ? "" : " selected"}>— no clip</option>
                  ${clips.map((item) => `
                  <option value="${value(item.media.filename)}"${
                    item.media.filename === card.motion_from ? " selected" : ""}
                    >${item.token.replace("<", "&lt;")} ${item.media.filename || ""}</option>`).join("")}
                </select>
              </label>`}
              ${card.keep !== "attribute_transfer" ? "" : `
              <label class="mmd-card-onto-box" title="Who receives what is taken from this person. attribute_transfer means a feature moves onto somebody else, and the guide asks for the target to be named -- otherwise the prompt says a face is transferred and never says onto whom. Pick another character, or describe whoever the shot is about.">onto
                <input class="mmd-card-onto" type="text"
                       placeholder="the man at the desk"
                       value="${value(card.onto)}">
                <select class="mmd-card-onto-pick" title="The other people in this clip, and what each shot is about. Picking one writes it into the box; the box takes anything else.">
                  <option value="">pick…</option>
                  ${state.cards
                    .filter((other, at) => at !== position && String(other.name || "").trim())
                    .map((other) => `<option value="${value(other.name)}">${value(other.name)}</option>`)
                    .join("")}
                  ${(timeline?.shots || [])
                    .map((shot) => String(shot.prompt || "").trim().split(/[,.]/)[0])
                    .filter(Boolean)
                    .map((subject) => `<option value="${value(subject)}">${value(subject)}</option>`)
                    .join("")}
                </select>
              </label>`}`}
              <span class="mmd-grow"></span>
              <button class="mmd-cast-drop" title="Remove this card">${ICON.trash}</button>
            </div>
            ${file ? `
            <input class="mmd-card-description" type="text"
                   placeholder="what it is, and what must stay the same"
                   value="${value(card.description)}">
            <div class="mmd-card-note" title="Where this sentence ends up. A file somebody is drawn out of gets no entry of its own in the prompt -- the guide asks for it to be cited inside the character's definition instead -- so this box is the one that reaches the model, and the block's own describes box stops being compiled."></div>` : `
            <div class="mmd-card-note mmd-card-wordless"></div>`}
            <div class="mmd-card-voice-row">
              <input class="mmd-card-voice" type="text"
                     title="How this person sounds, not what they say. Compiled as the words in front of (S1) -- age, gender, pitch, timbre, accent, pace. The lines themselves are written on a shot's dialogue row, because the same person speaks in several shots and says something different in each."
                     placeholder="how they sound — not what they say: age, gender, pitch, timbre, accent"
                     value="${value(card.voice)}">
              ${!heard.length ? "" : `
              <label class="mmd-card-from mmd-card-voice-src" title="Take the timbre from a recording instead of describing it. The signal is never copied -- only the voice and the delivery are followed -- and the prompt says so in the guide's own words.">voice from
                <select class="mmd-card-voice-from">
                  <option value=""${card.voice_from ? "" : " selected"}>— no recording</option>
                  ${heard.map((item) => `
                  <option value="${value(item.media.filename)}"${
                    item.media.filename === card.voice_from ? " selected" : ""}
                    >${item.token.replace("<", "&lt;")} ${item.media.filename || ""}</option>`).join("")}
                </select>
              </label>`}
            </div>
          </div>
        </div>`;
      }).join("")
        || `<div class="mmd-cast-empty">Nothing yet. Add a subject — a person, a costume,
             a prop, a place — then say what it is, and how they sound if they speak.</div>`;
    }
    // Both branches: the note under a description is filled by `paint` alone, so a list
    // that was just rebuilt would show an empty one until the next keystroke.
    this.paint(state, numbers);

    // A card taller or shorter than the room the list has been given is what the host
    // needs to know about, so the height follows the list on every render rather than on
    // a gesture.
    requestAnimationFrame(() => this.onResize?.());
  }

  /** Values and numbers, for a list whose shape has not changed. */
  paint(state, numbers = null) {
    const timeline = this.timeline();
    const marks = numbers || numbering(timeline, state.cards);
    const files = filesOf(timeline || {});
    // Which speaker numbers a line actually names. A card with a voice and nobody saying
    // anything in it is as idle as a card with no voice at all -- and the prompt is worse
    // for it, because a timbre reference names a speaker that is never voiced.
    const speaking = new Map();
    const ordered = [...items(timeline || {}, "shots")].sort((a, b) => a.start - b.start);
    ordered.forEach((shot, at) => {
      for (const line of shot.lines || []) {
        if (!String(line.text || "").trim()) continue;
        for (const id of speakerNumbers(line.ids)) {
          if (!speaking.has(id)) speaking.set(id, []);
          if (!speaking.get(id).includes(at + 1)) speaking.get(id).push(at + 1);
        }
      }
    });
    state.cards.forEach((card, position) => {
      const row = this.list.querySelector(`[data-card="${position}"]`);
      if (!row) return;

      const index = marks.get(card.uid || card.id) || 0;
      const shots = speaking.get(card.id) || [];
      const badge = row.querySelector(".mmd-card-subject");
      if (badge) {
        badge.textContent = `<Subject ${index}>`;
        badge.classList.toggle("mmd-hide", !index);
      }

      // Where this card is heard, mirroring the lit chips on a shot's dialogue row. The
      // binding is authored over there and was invisible here, which made a card look
      // unused whenever the TIMELINE tab was the one not on screen.
      const said = row.querySelector(".mmd-card-heard");
      if (said) {
        said.textContent = shots.map((number) => `[Shot ${number}]`).join(" ");
        said.classList.toggle("mmd-hide", !shots.length);
      }

      // The absence of a `<Subject n>` is a fact about this card, not a gap in the row:
      // drawn hollow, it is the answer to "why does the other one have a badge".
      const none = row.querySelector(".mmd-card-nosubject");
      if (none) none.classList.toggle("mmd-hide", !!index);

      // Both notes are painted rather than built: one turns on at the first character
      // typed into the description, the other at the first character of a voice -- and
      // rebuilding the list on a keystroke takes the caret with it.
      const note = row.querySelector(".mmd-card-note");
      const file = files.find((item) => (item.media.filename || "") === card.file) || null;

      // What this card actually contributes. It is a `<Subject n>` when it names a file
      // *and* says what that file is -- a file with nothing written about it takes no
      // number -- or it is the words in front of `(S1)` when it describes a voice. With
      // neither, the compiled prompt is byte-for-byte what it would be with no card here.
      const described = !!file && !!card.description.trim();
      const voiced = !!(card.voice.trim() || card.voice_from);
      // A voice is an instruction about how somebody sounds; with no line naming it, it
      // instructs nothing. Exempt while `they speak` is off, when no line is compiled at
      // all -- the same exemption the linter makes.
      const heard = state.speech === false || shots.length > 0;
      const mode = !described && !voiced ? "dead"
        : (!described && !heard ? "mute" : "ok");
      row.classList.toggle("mmd-card-off", mode !== "ok");

      // Which box the amber line is about, outlined in the same amber: the line says what
      // is missing, the outline says where it goes. Only on a card that is off -- a
      // warning colour on a card that already compiles is a warning about nothing -- and
      // only where there is something to point at. `mute` is the exception: the words that
      // card is waiting for are written on a shot's dialogue row, not on the card.
      const asks = mode === "ok" ? []
        : (file ? [".mmd-card-description"]
                : (voiced ? [] : [".mmd-card-file", ".mmd-card-voice"]));
      for (const box of row.querySelectorAll(".mmd-ask")) box.classList.remove("mmd-ask");
      for (const selector of asks) row.querySelector(selector)?.classList.add("mmd-ask");

      if (note && note.classList.contains("mmd-card-wordless")) {
        note.innerHTML = {
          dead: `this card compiles to nothing — give it a voice, or point <b>from</b> at
                 a file.`,
          mute: `nobody speaks this card's lines — the words go on a shot's
                 <b>dialogue</b> row, where you tick this face. The box below is
                 <b>how they sound</b>, not what they say.`,
          ok: `no file: this card gives a voice and nothing else. Pick one in <b>from</b>
               to make it a &lt;Subject n&gt; you can describe.`,
        }[mode];
        note.title = {
          dead: "A card reaches the prompt as a subject drawn out of a file, or as the words in front of (S1). With neither, the compiled prompt is byte-for-byte what it would be with no card here at all.",
          mute: "A voice is an instruction about how somebody sounds, and with no line it instructs nothing. The words themselves belong to a shot, not to a person -- one card can speak in four of them.",
          ok: "A subject is drawn out of a file. Without one there is nothing for the prompt to point at, so this card supplies a voice and nothing else -- which is all a speaker with no picture needs.",
        }[mode];
      } else if (note) {
        // A file is picked. Until something is written about it the card takes no number
        // and adds no line to the prompt, which is the same nothing as an empty card --
        // so it reads the same way, rather than looking finished because a select is set.
        // A file that is in the video on its own account -- a frame, a storyboard, an edit
        // source -- keeps its entry however many subjects are lifted out of it. Saying it
        // has no line of its own is false there, and the prompt says so plainly: the
        // storyboard sentence and both <Subject n> definitions are all present.
        const role = file ? String(file.media.role || "reference") : "reference";
        const keeps = Boolean(file) && role !== "reference";
        const own = file && !keeps ? String(file.media.description || "").trim() : "";
        note.innerHTML = !described
          ? `nothing is written about ${text(file ? file.token : "this file")} yet, so it
             takes no &lt;Subject n&gt; — say what it is below.`
          : (!index ? "" : (keeps
            ? `this sentence is &lt;Subject ${index}&gt;. ${text(file.token)} keeps a line
               of its own as a ${text(role)}.`
            : `${text(file.token)} has no line of its own — this sentence is
               &lt;Subject ${index}&gt;${
                 own ? `, and its own “${text(own)}” is not compiled.` : "."}`));
      }

      for (const [selector, text] of [
        [".mmd-card-name", card.name],
        [".mmd-card-description", card.description],
        [".mmd-card-voice", card.voice],
        [".mmd-card-onto", card.onto],
      ]) {
        const box = row.querySelector(selector);
        if (box && box !== document.activeElement) box.value = String(text || "");
      }
    });
  }
}
