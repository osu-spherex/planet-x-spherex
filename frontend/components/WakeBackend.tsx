"use client";

import { useEffect } from "react";
import { wakeBackend } from "@/lib/wake";

/** Starts waking the sleeping backend as soon as the page opens (lib/wake.ts). Renders nothing. */
export function WakeBackend() {
  useEffect(() => {
    wakeBackend();
  }, []);
  return null;
}
