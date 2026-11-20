"use client";

import {useEffect} from "react";

const MAP_SELECTOR = "[data-driver-interactive-map]";

// Driver owns this document. Cancel native page scaling, not SDK input.
// No click, keyboard, wheel, or business-action listeners are installed.
export function installDriverPageZoomGuard(owner: Document): () => void {
  let blockedPageGesture = false;
  const cancel = (event: Event) => {
    if (event.cancelable) event.preventDefault();
  };
  const mapFor = (target: EventTarget | null): Element | null =>
    target instanceof Element ? target.closest(MAP_SELECTOR) : null;

  const onTouch = (event: TouchEvent) => {
    if (event.touches.length > 1) {
      const touches = Array.from(event.touches);
      const firstMap = mapFor(touches[0].target);
      // Touch.target remains the initial target even when a finger crosses
      // the border. Only contacts originating in the same map belong to it.
      const mapGesture = firstMap !== null && owner.contains(firstMap) &&
        touches.every(touch => mapFor(touch.target) === firstMap);
      if (!mapGesture) blockedPageGesture = true;
    }
    if (blockedPageGesture) cancel(event);
  };
  const onTouchEnd = (event: TouchEvent) => {
    if (event.touches.length === 0) blockedPageGesture = false;
  };
  const reset = () => {blockedPageGesture = false;};
  const active = {capture:true, passive:false};
  const passive = {capture:true, passive:true};

  // Native listeners must be explicitly non-passive to cancel browser zoom.
  // Never stopPropagation: map handlers must still see the gestures.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    owner.addEventListener(type, cancel, active);
  }
  owner.addEventListener("touchstart", onTouch, active);
  owner.addEventListener("touchmove", onTouch, active);
  owner.addEventListener("touchend", onTouchEnd, passive);
  owner.addEventListener("touchcancel", onTouchEnd, passive);
  owner.addEventListener("visibilitychange", reset);
  owner.defaultView?.addEventListener("blur", reset);

  return () => {
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
      owner.removeEventListener(type, cancel, true);
    }
    owner.removeEventListener("touchstart", onTouch, true);
    owner.removeEventListener("touchmove", onTouch, true);
    owner.removeEventListener("touchend", onTouchEnd, true);
    owner.removeEventListener("touchcancel", onTouchEnd, true);
    owner.removeEventListener("visibilitychange", reset);
    owner.defaultView?.removeEventListener("blur", reset);
    reset();
  };
}

export default function DriverPageZoomGuard() {
  useEffect(() => installDriverPageZoomGuard(document), []);
  return null;
}
