import type { NextConfig } from "next";

// NEXT_OUTPUT=export builds a plain static site into out/ (no Node server): the fallback host when
// Vercel cannot deploy (deploy/README.md, "Нөөц хост"). Partial prerendering cannot be combined with
// a static export ("PPR cannot be enabled in export mode"), so those two options are left out then.
// Vercel builds without the variable, exactly as before.
const staticExport = process.env.NEXT_OUTPUT === "export";

const nextConfig: NextConfig = staticExport
  ? // trailingSlash: every page becomes <name>/index.html, which any static host serves at /<name>/
    // (out/method.html next to a folder out/method/ is not served at /method by every host).
    { output: "export", trailingSlash: true }
  : {
      cacheComponents: true,
      partialPrefetching: true,
    };

export default nextConfig;
