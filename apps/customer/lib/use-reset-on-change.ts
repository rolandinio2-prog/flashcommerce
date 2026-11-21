'use client';
import { useState } from 'react';

const UNSET: unique symbol = Symbol('unset');

/**
 * Runs `reset` during render whenever `deps` change (compared with Object.is, like an effect),
 * including the first render — the React-recommended "adjust state when a prop changes" pattern.
 * Use it for synchronous state resets (loading/error/data) that used to sit at the top of an
 * effect; keep the effect only for the actual request or external subscription.
 * `reset` may only update state of the calling component.
 */
export function useResetOnChange(deps: readonly unknown[], reset: () => void): void {
  const [previous, setPrevious] = useState<readonly unknown[] | typeof UNSET>(UNSET);
  const changed =
    previous === UNSET ||
    previous.length !== deps.length ||
    deps.some((value, index) => !Object.is(value, previous[index]));
  if (changed) {
    setPrevious(deps);
    reset();
  }
}
