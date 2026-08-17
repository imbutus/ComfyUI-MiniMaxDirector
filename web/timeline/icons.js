/**
 * The pack's icons as inline SVG, in one module because two files draw them now.
 *
 * Emoji were the obvious shortcut and the wrong one: a colour emoji renders at the
 * mercy of whatever font the host has, and the wastebasket in particular came out as a
 * mismatched blob. These are strokes in `currentColor`, so they match the button text
 * on any platform and inherit hover and disabled states for free.
 */
const svg = (body) =>
  `<svg class="mmd-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor"` +
  ` stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICON = {
  image: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1"/><path d="M2.6 12l3.4-3.6 2.4 2.3 2-1.9 3 3.2"/>'),
  text: svg('<path d="M3 4h10M8 4v9M6 13h4"/>'),
  audio: svg('<path d="M6 12V4l7-1.4v8"/><circle cx="4.4" cy="12" r="1.7"/><circle cx="11.4" cy="10.6" r="1.7"/>'),
  video: svg('<rect x="2" y="4" width="8.5" height="8" rx="1.2"/><path d="M10.5 7.4L14 5.4v5.2l-3.5-2z"/>'),
  camera: svg('<circle cx="8" cy="8" r="4.6"/><path d="M8 3.4V1.8M12.6 8h1.6"/><circle cx="8" cy="8" r="1.4"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 001 .8h3.8a1 1 0 001-.8l.6-8.2M7 7v4M9 7v4"/>'),
  sound: svg('<path d="M1.5 8h2l2-4.5 2 9 2-7 1.5 2.5h2"/>'),
  reset: svg('<path d="M13.5 8a5.5 5.5 0 11-1.9-4.2M13.5 2.2v3.1h-3.1"/>'),
  caret: svg('<path d="M4 6.2l4 4.2 4-4.2"/>'),
  files: svg('<path d="M1.8 12.6V4.2a1 1 0 011-1h3l1.2 1.6h5.2a1 1 0 011 1v6.8a1 1 0 01-1 1H2.8a1 1 0 01-1-1z"/>'),
};
