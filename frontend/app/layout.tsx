import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Unbounded } from "next/font/google";
import "./globals.css";
import { WakeBackend } from "@/components/WakeBackend";

// Three families, all under the SIL Open Font License, fetched at build time and served by the site
// itself (task A-18): Unbounded for the title and object names, IBM Plex Sans for text, IBM Plex
// Mono for numbers, coordinates and small labels. The tokens that use them are in globals.css.
const display = Unbounded({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600"],
});

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Planet X & SPHEREx",
  description: "Watch a patch of sky change over time in SPHEREx images: find objects that move or vary in brightness.",
};

// Explicit props type: the generated LayoutProps<"/"> helper only exists after `next dev`,
// `next build` or `next typegen`, so `npm run typecheck` failed in a fresh checkout.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <WakeBackend />
        {children}
      </body>
    </html>
  );
}
