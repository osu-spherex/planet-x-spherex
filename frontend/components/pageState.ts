// What the home page shows, read from and written to the URL (task B-09). Pure functions, so the
// rules are tested without a browser.
//
//   ?object=barnard                       one of the five objects (3′, its prepared detector)
//   ?object=barnard&band=D2&fov=6         the same field in another detector / field width
//   ?ra=133.79513&dec=-7.24515&band=D6    any position (6′ by default)
//   …&embed=1                             only the viewer, for an <iframe> on another site

import { isBand, isFov, type Band, type Fov } from "@/lib/backend";
import { positionFromParams, toParam, type SkyPosition } from "@/lib/coords";
import { findDemoObject, type DemoObject } from "@/lib/objects";

/** Field width when none is given: 3′ for the prepared objects (their static cubes are 3′), 6′ for
 *  a typed position, so a target that moved since its catalogue epoch is still in the field. */
export const DEFAULT_FOV_OBJECT: Fov = 3;
export const DEFAULT_FOV_POSITION: Fov = 6;

export interface PageState {
  /** A typed position, or null when one of the five objects is shown. */
  custom: SkyPosition | null;
  object: DemoObject | null;
  band: Band;
  fov: Fov;
  embed: boolean;
}

interface ParamsLike {
  get(name: string): string | null;
}

export function readState(params: ParamsLike): PageState {
  // A valid ?ra=&dec= wins; otherwise one of the five objects (the first by default).
  const custom = positionFromParams(params.get("ra"), params.get("dec"));
  const object = custom ? null : findDemoObject(params.get("object"));
  const bandParam = params.get("band");
  const defaultBand: Band = object && isBand(object.band) ? object.band : "D1";
  const band: Band = isBand(bandParam) ? bandParam : defaultBand;
  const fovParam = Number(params.get("fov"));
  const fov: Fov = isFov(fovParam) ? fovParam : custom ? DEFAULT_FOV_POSITION : DEFAULT_FOV_OBJECT;
  return { custom, object, band, fov, embed: params.get("embed") === "1" };
}

/** The query string for a state; defaults are left out so links stay short and stable. */
export function stateQuery(s: Pick<PageState, "custom" | "object" | "band" | "fov" | "embed">): string {
  const q = new URLSearchParams();
  if (s.custom) {
    q.set("ra", toParam(s.custom.ra));
    q.set("dec", toParam(s.custom.dec));
    q.set("band", s.band);
    if (s.fov !== DEFAULT_FOV_POSITION) q.set("fov", String(s.fov));
  } else {
    const o = s.object ?? findDemoObject(null);
    q.set("object", o.id);
    if (s.band !== o.band) q.set("band", s.band);
    if (s.fov !== DEFAULT_FOV_OBJECT) q.set("fov", String(s.fov));
  }
  if (s.embed) q.set("embed", "1");
  return q.toString();
}

/** Static cube of a prepared object in a detector (exists for every detector once A-08 is in). */
export function staticCubeUrl(objectId: string, band: Band): string {
  return `/cubes/${objectId}/${band}/cube.json`;
}

/** Size of the suggested <iframe>: one viewer column plus its controls. */
export const EMBED_WIDTH = 560;
export const EMBED_HEIGHT = 900;

/** HTML to paste into another page. `pageUrl` is the full URL of the view without embed=1. */
export function embedCode(pageUrl: string, width = EMBED_WIDTH, height = EMBED_HEIGHT): string {
  const u = new URL(pageUrl);
  u.searchParams.set("embed", "1");
  const src = u.toString().replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<iframe src="${src}" width="${width}" height="${height}" style="border:0" title="SPHEREx images (Planet X &amp; SPHEREx)" loading="lazy"></iframe>`;
}
