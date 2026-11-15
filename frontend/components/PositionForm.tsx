"use client";

// "Look anywhere": one text field for a sky position, in decimal degrees or in hours/degrees,
// minutes and seconds. What was understood is shown back before anything is fetched.

import { useState, type FormEvent } from "react";
import { formatDegrees, formatSexagesimal, parseCoordinates, toParam, type SkyPosition } from "@/lib/coords";
import styles from "./explorer.module.css";

export interface PositionFormProps {
  /** Position currently shown, if it came from this form (pre-fills the field). */
  current: SkyPosition | null;
  onSubmit: (position: SkyPosition) => void;
}

export function PositionForm({ current, onSubmit }: PositionFormProps) {
  const [text, setText] = useState(current ? `${toParam(current.ra)} ${toParam(current.dec)}` : "");
  const [submitted, setSubmitted] = useState(false);
  const result = parseCoordinates(text);
  const showError = submitted && !result.ok;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (result.ok) onSubmit({ ra: result.ra, dec: result.dec });
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <label className={styles.label} htmlFor="position">
        Or look at any position in the sky
      </label>
      <div className={styles.row}>
        <input
          id="position"
          className={styles.input}
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="08h55m10.8s -07d14m42s  or  133.7951 -7.2451"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSubmitted(false);
          }}
          aria-invalid={showError}
          aria-describedby="position-help"
        />
        <button type="submit" className={styles.button}>
          Show
        </button>
      </div>
      <p id="position-help" className={showError ? styles.error : styles.help} role={showError ? "alert" : undefined}>
        {showError && !result.ok
          ? result.error
          : result.ok
            ? `Understood as ${formatSexagesimal(result)}  (${formatDegrees(result)})`
            : "Right ascension, then declination. Degrees, or hours:minutes:seconds and degrees:minutes:seconds."}
      </p>
    </form>
  );
}

export default PositionForm;
