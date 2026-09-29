/**
 * Meshtastic identifies a node two ways: a uint32 `nodeNum` on the wire and
 * a `!hex` string in the UI and CLI. We store and query by `nodeNum` and
 * convert only at the boundary -- mixing the two internally is how you end
 * up comparing `"!a4c138f0"` against `2764474096` and getting nowhere.
 */

/** `2764474096` -> `"!a4c138f0"` */
export function toNodeId(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Accepts `"!a4c138f0"`, `"a4c138f0"`, or a decimal string.
 * Returns null rather than NaN so callers must handle bad input.
 */
export function parseNodeId(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const hex = trimmed.startsWith("!") ? trimmed.slice(1) : null;
  if (hex !== null) {
    if (!/^[0-9a-fA-F]{1,8}$/.test(hex)) return null;
    return Number.parseInt(hex, 16) >>> 0;
  }

  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    return Number.isSafeInteger(num) && num >= 0 && num <= 0xffffffff
      ? num >>> 0
      : null;
  }

  if (/^[0-9a-fA-F]{8}$/.test(trimmed)) {
    return Number.parseInt(trimmed, 16) >>> 0;
  }

  return null;
}
