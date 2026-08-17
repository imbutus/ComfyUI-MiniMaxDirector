/**
 * Media attached to a segment.
 *
 * A director that can only hold text is a text editor with rulers. Dropping a picture
 * onto a shot is the point, so a segment carries an optional `media` record:
 *
 *     { kind: "image" | "video" | "audio", filename: "x.png", subfolder: "" }
 *
 * The file itself lives in ComfyUI's input folder, uploaded through the same endpoint
 * `LoadImage` uses. The timeline stores only the reference, so a saved workflow stays
 * small and the file survives a browser reload.
 */

import { api } from "../../../scripts/api.js";

const ENDPOINT = { image: "/upload/image", video: "/upload/image", audio: "/upload/image" };

const ACCEPT = {
  image: "image/*",
  video: "video/*",
  audio: "audio/*",
  // The Files list takes any of the three: a file is a file, and which one it is is
  // something the file already says. Asking the author to pick the kind first was a
  // question with the answer written on the thing they were about to choose.
  any: "image/*,audio/*,video/*",
};

/** Which of the three kinds a chosen file is, or null when the browser will not say. */
export function kindOf(file) {
  const type = String(file?.type || "");
  for (const kind of ["image", "audio", "video"]) {
    if (type.startsWith(`${kind}/`)) return kind;
  }
  return null;
}

/** Browser file picker, resolved to the chosen File or null. */
export function pick(kind) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT[kind] ?? "*/*";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** Upload into ComfyUI's input folder; returns a media record. */
export async function upload(kind, file) {
  const body = new FormData();
  body.append("image", file); // the endpoint's field name, whatever the media kind
  body.append("type", "input");
  body.append("overwrite", "false");

  const response = await api.fetchApi(ENDPOINT[kind] ?? "/upload/image", { method: "POST", body });
  if (!response.ok) throw new Error(`upload failed: ${response.status}`);

  const result = await response.json();
  return {
    kind,
    filename: result.name ?? file.name,
    subfolder: result.subfolder ?? "",
  };
}

/** URL ComfyUI serves the file from. */
export function url(media) {
  if (!media?.filename) return null;
  return api.apiURL(
    `/view?filename=${encodeURIComponent(media.filename)}` +
    `&type=input&subfolder=${encodeURIComponent(media.subfolder || "")}`,
  );
}

/** The file's own pixel dimensions, once the browser has loaded it. */
export function dimensions(record) {
  return new Promise((resolve) => {
    const src = url(record);
    if (!src) return resolve(null);
    const probe = new Image();
    probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => resolve(null);
    probe.src = src;
  });
}

/**
 * How long a reference video or audio clip runs, in seconds.
 *
 * Read from the browser rather than the server: the file is already uploaded and served,
 * and a `<video>` element knows its own duration without a decode pass. `null` when the
 * browser cannot say -- a container it will not open, or a stream with no duration -- and
 * an unknown duration is never reported as a problem.
 */
export function seconds(record) {
  return new Promise((resolve) => {
    const src = url(record);
    if (!src) return resolve(null);
    const probe = document.createElement(record.kind === "audio" ? "audio" : "video");
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      const value = probe.duration;
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    };
    probe.onerror = () => resolve(null);
    probe.src = src;
  });
}

/**
 * Generation size that matches a reference image.
 *
 * The aspect ratio is taken from the image, but the pixel count is capped: a phone photo
 * would otherwise ask for a 4000x3000 generation, which is not a framing decision, it is
 * an out-of-memory error. Both sides land on multiples of 32, which is the step the H3
 * node declares.
 */
export function fitGeneration(size, budget = 1344 * 768) {
  const round32 = (n) => Math.max(32, Math.round(n / 32) * 32);
  const scale = Math.min(1, Math.sqrt(budget / (size.width * size.height)));
  return { width: round32(size.width * scale), height: round32(size.height * scale) };
}

/**
 * Build the visual for a segment's media.
 *
 * Images become a tiled background so a wide segment reads as a filmstrip rather than
 * one stretched frame. Video gets a real `<video>` element seeked to its first frame --
 * cheaper and more honest than inventing a thumbnail. Audio gets a waveform, drawn from
 * the decoded samples rather than faked.
 */
export function decorate(node, media) {
  const src = url(media);
  if (!src) return;

  node.classList.add("mmd-has-media");

  if (media.kind === "image") {
    node.style.backgroundImage = `url("${src}")`;
    node.style.backgroundSize = "auto 100%";
    node.style.backgroundRepeat = "repeat-x";
    return;
  }

  if (media.kind === "video") {
    const video = document.createElement("video");
    video.className = "mmd-media";
    video.src = src;
    video.muted = true;
    video.preload = "metadata";
    // Nudge past zero so the browser actually paints a frame rather than black.
    video.addEventListener("loadedmetadata", () => { video.currentTime = 0.04; }, { once: true });
    node.appendChild(video);
    return;
  }

  if (media.kind === "audio") {
    const canvas = document.createElement("canvas");
    canvas.className = "mmd-media mmd-wave";
    node.appendChild(canvas);
    waveform(canvas, src);
  }
}

/** Envelopes already computed, by URL. See `peaksOf`. */
const ENVELOPES = new Map();

/** How many buckets an envelope is stored at: far more than any block is wide on screen,
 *  so redrawing at a new width resamples rather than re-reads the file. */
const BUCKETS = 2000;

/**
 * The clip's envelope, decoded once per file per session.
 *
 * Every render rebuilds the track's elements, and this used to re-download and re-decode
 * the whole file each time -- for an eight-minute mp3 that is seconds of work and a
 * waveform that visibly vanishes and comes back on every click. The promise is cached
 * rather than the result, so ten blocks drawn in the same frame share one decode instead
 * of starting ten.
 */
function peaksOf(src) {
  if (ENVELOPES.has(src)) return ENVELOPES.get(src);
  const work = (async () => {
    const bytes = await (await fetch(src)).arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const audio = await ctx.decodeAudioData(bytes);
      const samples = audio.getChannelData(0);
      const step = Math.max(1, Math.floor(samples.length / BUCKETS));
      const peaks = new Float32Array(BUCKETS);
      for (let bucket = 0; bucket < BUCKETS; bucket++) {
        let peak = 0;
        for (let i = 0; i < step; i++) {
          peak = Math.max(peak, Math.abs(samples[bucket * step + i] || 0));
        }
        peaks[bucket] = peak;
      }
      return peaks;
    } finally {
      ctx.close();
    }
  })();
  // A failed decode is cached too: retrying it on every render is the same stall, only
  // without ever producing a waveform.
  ENVELOPES.set(src, work.catch(() => null));
  return ENVELOPES.get(src);
}

/** Draw the envelope. Silent on failure -- it is decoration. */
async function waveform(canvas, src) {
  const peaks = await peaksOf(src);
  if (!peaks || !canvas.isConnected) return;

  const width = Math.max(1, canvas.clientWidth || 200);
  const height = Math.max(1, canvas.clientHeight || 30);
  canvas.width = width;
  canvas.height = height;

  const paint = canvas.getContext("2d");
  paint.fillStyle = "#7fbf6a";
  const step = peaks.length / width;

  for (let x = 0; x < width; x++) {
    let peak = 0;
    for (let i = Math.floor(x * step); i < Math.floor((x + 1) * step); i++) {
      peak = Math.max(peak, peaks[i] || 0);
    }
    const bar = Math.max(1, peak * height);
    paint.fillRect(x, (height - bar) / 2, 1, bar);
  }
}
