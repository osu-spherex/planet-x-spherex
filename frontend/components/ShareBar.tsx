"use client";

// "Copy link" and "Copy embed code" for the current view (task B-09). The embed code is an
// <iframe> of the same URL with embed=1, which shows only the viewer.

import { useState } from "react";
import { embedCode } from "./pageState";
import styles from "./explorer.module.css";

export interface ShareBarProps {
  /** Query string of the current view, without embed. */
  query: string;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ShareBar({ query }: ShareBarProps) {
  const [status, setStatus] = useState<string>("");
  const pageUrl = () => `${window.location.origin}${window.location.pathname}?${query}`;

  const run = async (what: "link" | "embed") => {
    const text = what === "link" ? pageUrl() : embedCode(pageUrl());
    const ok = await copy(text);
    setStatus(
      ok
        ? what === "link"
          ? "Link copied."
          : "Embed code copied: paste it into any web page."
        : `Copy failed; select and copy this instead: ${text}`,
    );
  };

  return (
    <div className={styles.share}>
      <button type="button" className={styles.button} onClick={() => run("link")}>
        Copy link
      </button>
      <button type="button" className={styles.button} onClick={() => run("embed")}>
        Copy embed code
      </button>
      <span className={styles.shareStatus} role="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}

export default ShareBar;
