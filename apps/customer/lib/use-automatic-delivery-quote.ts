"use client";
import { useEffect, useRef } from 'react';

// One attempt per settled input snapshot. Failures do not create retry loops.
export function useAutomaticDeliveryQuote({ inputKey, enabled, open, calculate }: {
  inputKey: string; enabled: boolean; open: boolean; calculate: () => Promise<void>;
}) {
  const lastAttempt = useRef<string | null>(null);
  const latest = useRef(calculate);
  latest.current = calculate;
  useEffect(() => { if (!open) lastAttempt.current = null; }, [open]);
  useEffect(() => {
    if (!open || !enabled || lastAttempt.current === inputKey) return;
    const timer = window.setTimeout(() => {
      lastAttempt.current = inputKey;
      void latest.current();
    }, 650);
    return () => window.clearTimeout(timer);
  }, [open, enabled, inputKey]);
}
