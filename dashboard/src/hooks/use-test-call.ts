import { useEffect, useState, useSyncExternalStore } from 'react';
import { TestCall } from '@/lib/phone/test-call';

/**
 * One TestCall for the console's lifetime — held above the tabs, so following the call
 * in Live does not hang it up. Re-renders on every change to it.
 */
export function useTestCall(): TestCall {
  const [call] = useState(() => new TestCall());
  useSyncExternalStore(
    (notify) => call.subscribe(notify),
    () => call.snapshot,
  );
  useEffect(() => () => call.hangUp(), [call]);
  return call;
}
