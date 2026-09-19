import { useCallback, useEffect, useState } from 'react';

export type View = 'overview' | 'live' | 'finished' | 'clinic' | 'testing';

export interface Route {
  view: View;
  /** The call open in that view, if any; on the clinic, the day open (YYYY-MM-DD). */
  callId: string | null;
}

const DEFAULT: Route = { view: 'overview', callId: null };

/** `#/overview`, `#/live/<id>`, `#/finished/<id>`, `#/clinic/<date>`, `#/testing`. The older `#/calls/<id>` still opens a finished call. */
function parse(hash: string): Route {
  const m = /^#\/(overview|live|finished|calls|clinic|testing)(?:\/(.+))?$/.exec(hash);
  if (!m) return DEFAULT;
  const view: View = m[1] === 'calls' ? 'finished' : (m[1] as View);
  return { view, callId: m[2] ? decodeURIComponent(m[2]) : null };
}

function format(route: Route): string {
  return `#/${route.view}${route.callId ? `/${encodeURIComponent(route.callId)}` : ''}`;
}

/**
 * The console's location, kept in the URL hash — a reload keeps the tab and the open
 * call, the back button walks back through them, and a link can be pasted to a teammate.
 */
export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = (): void => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    const hash = format(next);
    if (hash !== window.location.hash) window.location.hash = hash;
    setRoute(next);
  }, []);

  return [route, navigate];
}
