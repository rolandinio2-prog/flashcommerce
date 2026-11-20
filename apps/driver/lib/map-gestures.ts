// Capture only Safari's browser gesture default inside this map.
// Do not stop propagation: the map SDK must still receive pinch gestures.
export function containMapGestures(container: HTMLElement): () => void {
  const preventPageGesture = (event: Event) => {
    if (event.cancelable) event.preventDefault();
  };
  const types = ["gesturestart", "gesturechange", "gestureend"];
  for (const type of types) container.addEventListener(type, preventPageGesture, {passive:false});
  return () => {
    for (const type of types) container.removeEventListener(type, preventPageGesture);
  };
}
