import { BatteryFull, BatteryLow, BatteryMedium, PlugZap } from "lucide-react";

/**
 * A battery percentage with a glyph whose fill matches it, as `SignalDot`
 * does for link quality: the shape carries the level on its own, so it
 * survives a grayscale screenshot or a red-green deficiency.
 *
 * Only low is colored. A half-full battery is not a problem, and an amber
 * icon on every such row would teach people to ignore the one that is.
 *
 * Above 100 is not a percentage: firmware reports external power that way
 * (101 is the usual value), so it reads as a plug rather than "101%".
 */

/** At or below this the node needs attention: red, one bar. */
const LOW_AT = 20;
/** At or below this, two bars; above, three. */
const MEDIUM_AT = 70;

export function BatteryLevel({ level }: { level: number }) {
  if (level > 100) {
    return (
      <span
        title="On external power. Firmware reports this as a battery level above 100%."
        className="inline-flex items-center gap-1 align-top"
      >
        <PlugZap aria-hidden className="h-3.5 w-3.5 shrink-0" />
        Plugged in
      </span>
    );
  }

  const low = level <= LOW_AT;
  const Icon = low ? BatteryLow : level <= MEDIUM_AT ? BatteryMedium : BatteryFull;

  return (
    <span
      title={low ? "Low battery" : undefined}
      className={`inline-flex items-center gap-1 align-top ${low ? "text-red-300" : ""}`}
    >
      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
      {level}%
    </span>
  );
}
