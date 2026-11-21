"use client";
import { useEffect, useEffectEvent, useRef } from 'react';

// One attempt per settled input snapshot. Failures do not create retry loops.
export function useAutomaticDeliveryQuote({ inputKey, enabled, open, calculate }: {
  inputKey: string; enabled: boolean; open: boolean; calculate: () => Promise<void>;
}) {
  const lastAttempt = useRef<string | null>(null);
  // Always runs the latest calculate() without re-arming the debounce when it changes.
  const runCalculate = useEffectEvent(() => { void calculate(); });
  useEffect(() => { if (!open) lastAttempt.current = null; }, [open]);
  useEffect(() => {
    if (!open || !enabled || lastAttempt.current === inputKey) return;
    const timer = window.setTimeout(() => {
      lastAttempt.current = inputKey;
      runCalculate();
    }, 650);
    return () => window.clearTimeout(timer);
  }, [open, enabled, inputKey]);
}
