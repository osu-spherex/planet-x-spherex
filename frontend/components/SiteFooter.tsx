"use client";

// Footer (task B-09): when the shown data was last updated, the AI note NASA asks for, and the
// credits of every archive the page uses.

import { useEffect, useState } from "react";
import styles from "./explorer.module.css";

export interface SiteFooterProps {
  /** Static cube.json of the current view, or null for a cube fetched live. */
  staticCubeUrl: string | null;
}

/** Latest download date in cube.json (source.downloaded_utc, data/cube.py), "YYYY-MM-DD". */
export function lastDownload(meta: { source?: { downloaded_utc?: string[] } } | null): string | null {
  const stamps = meta?.source?.downloaded_utc;
  if (!Array.isArray(stamps) || stamps.length === 0) return null;
  return [...stamps].sort().at(-1)!.slice(0, 10);
}

export function SiteFooter({ staticCubeUrl }: SiteFooterProps) {
  const [date, setDate] = useState<{ url: string; value: string | null } | null>(null);

  useEffect(() => {
    if (!staticCubeUrl) return;
    let cancelled = false;
    fetch(staticCubeUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (meta) => !cancelled && setDate({ url: staticCubeUrl, value: lastDownload(meta) }),
        () => !cancelled && setDate({ url: staticCubeUrl, value: null }),
      );
    return () => {
      cancelled = true;
    };
  }, [staticCubeUrl]);

  const shown = staticCubeUrl && date?.url === staticCubeUrl ? date.value : null;

  return (
    <footer className={styles.footer}>
      <p>
        {staticCubeUrl
          ? shown
            ? `Data last updated ${shown} (prepared images, downloaded from NASA's archive).`
            : "Prepared images, downloaded from NASA's archive."
          : "Images fetched from NASA's archive when you open this position."}
      </p>
      <p>
        Code written with AI assistance (Claude). See <a href="/method">How it works</a> for the method, its limits and
        how AI was used.
      </p>
      <p>
        Images: NASA SPHEREx Level 2 spectral images from the NASA/IPAC Infrared Science Archive (IRSA). Catalogue
        layer: ESA Gaia DR3 (Gaia Collaboration, Vallenari et al. 2023, A&amp;A 674, A1; data processed by the Gaia
        DPAC) and CatWISE2020 (Marocco et al. 2021, ApJS 253, 8), both queried through IRSA.
      </p>
    </footer>
  );
}

export default SiteFooter;
