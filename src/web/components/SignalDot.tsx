import { SignalHigh, SignalLow, SignalMedium, SignalZero } from "lucide-react";
import type { SignalQuality } from "../../shared/types";

/**
 * Link quality indicator, sitting alongside `StatusDot` in the fleet list.
 *
 * Graduated bars rather than another coloured dot: the two indicators share
 * a colour language (emerald good, amber middling, red bad), so a second
 * dot would read as a duplicate of the online/stale state. The bar glyph
 * says "signal" on its own, and carries the meaning where colour cannot —
 * a grayscale screenshot or a red-green deficiency still shows three
 * distinct shapes.
 *
 * `unknown` is a flat icon in muted grey, never red: a node heard only
 * through a relay has no direct measurement, which is not a bad link.
 */
const STYLES: Record<
  SignalQuality,
  { icon: typeof SignalHigh; text: string; label: string; title: string }
> = {
  good: {
    icon: SignalHigh,
    text: "text-emerald-300",
    label: "Good",
    title: "Strong direct link.",
  },
  medium: {
    icon: SignalMedium,
    text: "text-amber-300",
    label: "Medium",
    title: "Workable direct link with limited margin.",
  },
  bad: {
    icon: SignalLow,
    text: "text-red-300",
    label: "Bad",
    title: "Direct link close to the limit of what the radio can decode.",
  },
  unknown: {
    icon: SignalZero,
    text: "text-neutral-500",
    // Echoes the admin badge's "Unprobed": both mean "never established",
    // not "established as bad".
    label: "Unmeasured",
    title:
      "No packet has arrived directly from this node, so its link quality has never been measured. Normal for a node reached through a relay.",
  },
};

export function SignalDot({ signal }: { signal: SignalQuality }) {
  const style = STYLES[signal];
  const Icon = style.icon;

  return (
    <span
      title={style.title}
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${style.text}`}
    >
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {style.label}
    </span>
  );
}
