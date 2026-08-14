/**
 * Which build of this extension the browser is running.
 *
 * ComfyUI serves extension scripts with ordinary HTTP caching, so a stale page looks
 * exactly like a bug that was never fixed. The stamp is shown in the settings row and
 * logged once at load, which turns "is my browser up to date?" into something checkable
 * instead of something to argue about.
 */

export const BUILD = "2026-08-14·20:35";

/**
 * Which release this is.
 *
 * The build stamp answers "is my browser up to date?"; this answers "which version of the
 * pack am I running?", which is the one you quote in a bug report. Kept in step with
 * `pyproject.toml` by a test, because two versions that can disagree eventually do.
 */
export const VERSION = "0.7.0";
