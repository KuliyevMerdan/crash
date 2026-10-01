import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { parseRoute, type Route } from './route.js';

const subscribe = (notify: () => void) => {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
};

/** The screen the URL hash names, kept current as it changes; each change starts at the top. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [hash]);
  return useMemo(() => parseRoute(hash), [hash]);
}
