/**
 * Which build of this extension the browser is running.
 *
 * ComfyUI serves extension scripts with ordinary HTTP caching, so a stale page looks
 * exactly like a bug that was never fixed. The stamp is shown in the settings row and
 * logged once at load, which turns "is my browser up to date?" into something checkable
 * instead of something to argue about.
 */

export const BUILD = "2026-08-11·05:20";
