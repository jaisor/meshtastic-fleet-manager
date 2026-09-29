/**
 * Fixed background layers, pinned behind all content. Adapted from
 * jaisor.net: the same amber and orange bloom over near-black, with a
 * faint grid standing in for the site's photographic backdrop.
 *
 * The grid is deliberately low contrast. Behind dense telemetry tables a
 * livelier background competes with the data, which is the thing people
 * actually came to read.
 */
export function Backdrop() {
  return (
    <>
      <div aria-hidden className="fixed inset-0 -z-10 bg-neutral-950" />
      <div
        aria-hidden
        className="fixed inset-0 -z-10 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(to right, #d4d4d4 1px, transparent 1px), linear-gradient(to bottom, #d4d4d4 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(ellipse at 50% 0%, black 30%, transparent 75%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed -top-40 -right-40 -z-10 h-96 w-96 rounded-full bg-amber-500/15 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none fixed top-1/2 -left-40 -z-10 h-80 w-80 rounded-full bg-orange-600/10 blur-3xl"
      />
    </>
  );
}
