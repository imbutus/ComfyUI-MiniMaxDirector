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
};

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

/** Decode the clip and draw its envelope. Silent on failure -- it is decoration. */
async function waveform(canvas, src) {
  try {
    const bytes = await (await fetch(src)).arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await ctx.decodeAudioData(bytes);
    const samples = audio.getChannelData(0);

    const width = Math.max(1, canvas.clientWidth || 200);
    const height = Math.max(1, canvas.clientHeight || 30);
    canvas.width = width;
    canvas.height = height;

    const paint = canvas.getContext("2d");
    paint.fillStyle = "#7fbf6a";
    const step = Math.max(1, Math.floor(samples.length / width));

    for (let x = 0; x < width; x++) {
      let peak = 0;
      for (let i = 0; i < step; i++) {
        peak = Math.max(peak, Math.abs(samples[x * step + i] || 0));
      }
      const bar = Math.max(1, peak * height);
      paint.fillRect(x, (height - bar) / 2, 1, bar);
    }
    ctx.close();
  } catch {
    /* an undecodable file simply shows no waveform */
  }
}
