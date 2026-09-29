import type { AdminCapability } from "../../shared/types";

/**
 * Whether the local node may remotely administer this one.
 *
 * `unknown` and `unreachable` are shown as their own states rather than
 * being folded into "no". Authorization lives in the remote node's
 * `adminKey` and cannot be read without already holding admin rights, so
 * a silent node is genuinely undetermined -- reporting that as a denial
 * would send someone off to fix a permission that was never broken.
 */
const STYLES: Record<
  AdminCapability,
  { label: string; className: string; title: string }
> = {
  capable: {
    label: "Admin",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    title: "This node answered an admin request from the local node.",
  },
  unauthorized: {
    label: "No admin",
    className: "border-red-500/40 bg-red-500/10 text-red-300",
    title:
      "This node refused an admin request. Add the local node's public key to its admin_key list.",
  },
  unreachable: {
    label: "No reply",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    title:
      "No response within the probe timeout. The node may be out of range rather than unauthorized.",
  },
  unknown: {
    label: "Unprobed",
    className: "border-neutral-700 bg-neutral-900/60 text-neutral-400",
    title: "Admin capability has not been established yet.",
  },
};

export function CapabilityBadge({ capability }: { capability: AdminCapability }) {
  const style = STYLES[capability];
  return (
    <span
      title={style.title}
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium [corner-shape:bevel] ${style.className}`}
    >
      {style.label}
    </span>
  );
}
