/**
 * Display helpers. Everything on the wire is UTC epoch seconds; every
 * rendered time is in the viewer's own zone.
 */

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** `1738280000` -> `"3 hours ago"`. */
export function relativeTime(epochSeconds: number | null): string {
  if (epochSeconds === null) return "never";
  const delta = epochSeconds - Math.floor(Date.now() / 1000);
  const magnitude = Math.abs(delta);

  for (const [unit, seconds] of UNITS) {
    if (magnitude >= seconds) {
      return RELATIVE.format(Math.round(delta / seconds), unit);
    }
  }
  return RELATIVE.format(Math.round(delta), "second");
}

/** Full local timestamp, for the `title` of a relative one. */
export function absoluteTime(epochSeconds: number | null): string {
  if (epochSeconds === null) return "never heard";
  return new Date(epochSeconds * 1000).toLocaleString();
}

/** Protobuf enum names arrive as `TRACKER_SOLAR`; show `Tracker solar`. */
export function humanizeEnum(value: string | null): string | null {
  if (!value) return null;
  const spaced = value.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Renders a numeric measurement, or an em dash when there is none. */
export function metric(
  value: number | null | undefined,
  unit: string,
  digits = 1,
): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(digits)}${unit}`;
}

export function uptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
