"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./order-design.module.css";

export function CarouselHint() {
  const ref = useRef<HTMLParagraphElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    if (!("IntersectionObserver" in window)) {
      // No observer: reveal on the next frame (no synchronous render cascade).
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { threshold: 0.8 });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return <p ref={ref} className={styles.carouselHint} data-visible={visible}>
    <span className={styles.carouselHintText}><span aria-hidden="true">←</span> Desliza para ver más productos <span aria-hidden="true">→</span></span>
  </p>;
}
