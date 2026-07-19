import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const publicDir = join(import.meta.dir, "../dist/public");

/** The built static files served under `/`, each with the content type the dashboard expects. */
const ASSETS: { name: string; type: string }[] = [
  { name: "app.css", type: "text/css" },
  { name: "htmx.min.js", type: "text/javascript" },
  { name: "favicon.svg", type: "image/svg+xml" },
];

export const htmlHeaders = { "content-type": "text/html; charset=utf-8" };

/** Content hash of the built assets, for cache-busting their `?v=` URLs; "dev" when unbuilt. */
export const assetsVersion: string = (() => {
  try {
    const hash = createHash("sha256");
    for (const { name } of ASSETS) hash.update(readFileSync(join(publicDir, name)));
    return hash.digest("hex").slice(0, 12);
  } catch {
    return "dev";
  }
})();

/** Serve a built asset by request path with a long immutable cache, or undefined when it isn't one. */
export function serveAsset(pathname: string): Response | undefined {
  const asset = ASSETS.find(({ name }) => pathname === `/${name}`);
  if (!asset) return undefined;
  return new Response(Bun.file(join(publicDir, asset.name)), {
    headers: { "cache-control": "public, max-age=31536000, immutable", "content-type": asset.type },
  });
}
