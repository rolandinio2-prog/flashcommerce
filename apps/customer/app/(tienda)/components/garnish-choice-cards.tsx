"use client";

import { useId } from "react";
import styles from "./order-design.module.css";

export type GarnishChoice = { id: string; name: string; imageUrl: string; available: boolean; detail?: string };

// The parent owns the business rules and persists the selected choice with the cart line.
export function GarnishChoiceCards({ choices, selectedId, onChange, disabled = false, caption }: {
  choices: GarnishChoice[]; selectedId: string | null; onChange: (id: string) => void; disabled?: boolean; caption?: string;
}) {
  const groupId=useId();
  return <fieldset className={styles.garnishGroup} disabled={disabled}>
    <legend>Guarnición {caption && <span>{caption}</span>}</legend>
    <div className={styles.garnishGrid}>
      {choices.map(choice=><label key={choice.id} className={selectedId===choice.id ? styles.garnishSelected : styles.garnishOption}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={choice.imageUrl} alt="" loading="lazy" decoding="async" />
        <span className={styles.garnishLabel}><input type="radio" name={groupId} value={choice.id} checked={selectedId===choice.id} disabled={!choice.available} onChange={()=>onChange(choice.id)} /><span>{choice.name}</span></span>
        {!choice.available ? <small>No disponible</small> : choice.detail && <small>{choice.detail}</small>}
      </label>)}
    </div>
  </fieldset>;
}
