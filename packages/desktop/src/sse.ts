/**
 * ============================================================================
 * SSE frame parser — decode the `GET /v1/events` management stream (§2.3)
 * ============================================================================
 *
 * The runtime emits frames as:
 *     event: <type>\n
 *     data: <json>\n
 *     \n
 * plus an opening comment line `: plexus management event stream`. We only need
 * the `data:` payload (it carries its own discriminant `type` field), so we parse
 * the JSON out of each complete frame.
 *
 * This is a streaming, buffering parser: feed it arbitrary chunks; it returns the
 * fully-parsed `PlexusEvent`s completed by that chunk and retains the partial
 * tail. Pure (no sockets/Electron) → directly unit-testable.
 */

import type { PlexusEvent } from "@plexus/protocol";

export class SseParser {
  private buffer = "";

  /**
   * Feed a raw chunk; return every complete event whose frame terminated within
   * the accumulated buffer. Comments (`:`-prefixed) and keep-alives are skipped;
   * malformed JSON frames are dropped (not thrown) so one bad frame can't kill the
   * stream.
   */
  push(chunk: string): PlexusEvent[] {
    this.buffer += chunk;
    const events: PlexusEvent[] = [];
    // Frames are separated by a blank line (\n\n). Keep the trailing partial.
    const frames = this.buffer.split("\n\n");
    this.buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const ev = parseFrame(frame);
      if (ev) events.push(ev);
    }
    return events;
  }
}

/** Parse one complete SSE frame's `data:` lines into a `PlexusEvent`, or null. */
export function parseFrame(frame: string): PlexusEvent | null {
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith(":")) continue; // comment / keep-alive
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
    // `event:`/`id:`/`retry:` lines ignored — the JSON carries its own `type`.
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === "string"
    ) {
      return parsed as PlexusEvent;
    }
    return null;
  } catch {
    return null;
  }
}
