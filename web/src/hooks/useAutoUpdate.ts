import { useEffect } from 'react';
import { isBusy } from '../lib/busy';

const CHECK_MS = 5 * 60 * 1000; // ask for the deployed version every 5 minutes
const RETRY_MS = 30 * 1000; // while busy, try again every 30 s

/**
 * Watch for a newer deploy: when version.json names another build than this one, reload as soon
 * as nothing would be lost (isBusy() false). Returns a stop function.
 */
export function watchForUpdate({
  build = __BUILD_ID__,
  url = `${import.meta.env.BASE_URL}version.json`,
  fetchImpl = (u: string) => fetch(u, { cache: 'no-store' }),
  reload = () => window.location.reload(),
}: {
  build?: string;
  url?: string;
  fetchImpl?: (url: string) => Promise<Response>;
  reload?: () => void;
} = {}): () => void {
  let pending = false;
  let stopped = false;
  let retry = 0;
  const reloadWhenIdle = () => {
    if (stopped || !pending) return;
    if (isBusy()) retry = window.setTimeout(reloadWhenIdle, RETRY_MS);
    else reload();
  };
  const check = async () => {
    if (stopped || pending) return;
    try {
      const res = await fetchImpl(url);
      if (!res.ok) return;
      const { build: deployed } = (await res.json()) as { build?: string };
      if (deployed && deployed !== build) {
        pending = true;
        reloadWhenIdle();
      }
    } catch {
      /* offline: try again later */
    }
  };
  const timer = window.setInterval(() => void check(), CHECK_MS);
  const onVisible = () => {
    if (document.visibilityState === 'visible') void check();
  };
  document.addEventListener('visibilitychange', onVisible);
  void check();
  return () => {
    stopped = true;
    window.clearInterval(timer);
    window.clearTimeout(retry);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/**
 * Keep an open tab on the deployed version. A tab left open across a deploy otherwise keeps
 * running the old page AND the old in-browser server, which can mix old and new behaviour. The
 * tab reloads itself once nothing would be lost (no AI read running, no unsaved edits); the data
 * lives in the browser's database, so a reload keeps it.
 */
export function useAutoUpdate(): void {
  useEffect(() => (import.meta.env.PROD ? watchForUpdate() : undefined), []);
}
