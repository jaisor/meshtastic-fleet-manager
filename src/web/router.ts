import { useCallback, useEffect, useState } from "react";

/**
 * A two-route router in thirty lines.
 *
 * The app has exactly one nested view (a node's detail page), so a routing
 * library would be more configuration than the problem deserves. If this
 * ever grows nested layouts or data loaders, swap it for a real router
 * rather than growing this file.
 */

export type Route =
  | { name: "fleet" }
  | { name: "node"; nodeId: string }
  | { name: "admin" };

function parse(pathname: string): Route {
  const match = /^\/nodes\/([^/]+)\/?$/.exec(pathname);
  if (match?.[1]) return { name: "node", nodeId: decodeURIComponent(match[1]) };
  if (/^\/admin\/?$/.test(pathname)) return { name: "admin" };
  return { name: "fleet" };
}

export function useRoute(): [Route, (path: string) => void] {
  const [route, setRoute] = useState<Route>(() => parse(window.location.pathname));

  useEffect(() => {
    // Back/forward buttons must work; without this the URL changes and the
    // view does not, which is worse than having no routing at all.
    const onPop = () => setRoute(parse(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((path: string) => {
    window.history.pushState({}, "", path);
    setRoute(parse(path));
    window.scrollTo(0, 0);
  }, []);

  return [route, navigate];
}

/** Path for a node's detail page. Node ids start with `!`, so encode. */
export function nodePath(nodeId: string): string {
  return `/nodes/${encodeURIComponent(nodeId)}`;
}
