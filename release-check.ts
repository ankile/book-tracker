// Post-release check that the public profile renderer and the Cloudflare
// Pages site agree on the app bundle. The two are released separately
// (`npm run pages:deploy`, then the Firebase CLI) but are coupled: the
// renderer serves a shell synchronised from the site build, and Pages keeps
// only the bundle it was last given. On 2026-09-21 a Pages-only release left
// the live renderer pointing at /_app/immutable/entry/*.js files the site no
// longer had; Pages answered those URLs with the SPA shell (200 text/html),
// the browser refused it as a module script, and every direct load of a
// profile URL was blank for three days. verifyRelease() reports that state
// as a failure. It reads the renderer through its own origin rather than the
// edge, because the edge serves a profile page for up to five minutes after
// a release and would otherwise report the previous renderer.
import {ORIGIN} from './cloudflare/worker.ts';

export const SITE = 'https://book.ankile.com';

// Every /_app/immutable/... URL a document references (module preloads,
// scripts, stylesheets), unique and sorted.
export function immutableAssetPaths(html: string): string[] {
  const paths = [...html.matchAll(/\/_app\/immutable\/[^"'`\\\s)]+/g)].map((match) => match[0]);
  return [...new Set(paths)].sort();
}

export function sitemapProfilePaths(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => new URL(match[1]).pathname)
    .filter((pathname) => pathname.startsWith('/profiles/'));
}

export interface ReleaseEndpoints {
  site: string;
  origin: string;
}

const LIVE: ReleaseEndpoints = {site: SITE, origin: ORIGIN};

// Returns the problems found; an empty list means the release is consistent.
export async function verifyRelease(
  fetchImpl: typeof fetch,
  localShell: string,
  endpoints: ReleaseEndpoints = LIVE,
): Promise<string[]> {
  const problems: string[] = [];
  const localPaths = immutableAssetPaths(localShell);

  const sitemap = await fetchImpl(`${endpoints.origin}/sitemap.xml`);
  if (sitemap.status !== 200) {
    return [`renderer sitemap answered ${sitemap.status}`];
  }
  const [profilePath] = sitemapProfilePaths(await sitemap.text());
  if (profilePath === undefined) {
    return ['renderer sitemap lists no public profile to check'];
  }

  const rendered = await fetchImpl(`${endpoints.origin}${profilePath}`);
  if (rendered.status !== 200) {
    return [`renderer answered ${rendered.status} for ${profilePath}`];
  }
  const renderedPaths = immutableAssetPaths(await rendered.text());
  if (renderedPaths.join('\n') !== localPaths.join('\n')) {
    problems.push(
      'renderer serves a shell that differs from functions/assets/profile-shell.html at HEAD ' +
        `(renderer: ${renderedPaths.join(', ')}; HEAD: ${localPaths.join(', ')}) — the backend was not deployed from this commit`,
    );
  }

  const index = await fetchImpl(`${endpoints.site}/`);
  if (index.status !== 200) {
    problems.push(`site answered ${index.status} for /`);
    return problems;
  }
  const sitePaths = immutableAssetPaths(await index.text());
  if (sitePaths.join('\n') !== localPaths.join('\n')) {
    problems.push(
      'site serves a bundle that differs from public/index.html at HEAD ' +
        `(site: ${sitePaths.join(', ')}; HEAD: ${localPaths.join(', ')}) — the site was not deployed from this commit`,
    );
  }

  // The failure the incident produced: a path the renderer references that
  // Pages no longer has. Pages answers an unknown path with the SPA shell,
  // so a 200 with an HTML body is as much a failure as a 404.
  for (const path of renderedPaths) {
    const asset = await fetchImpl(`${endpoints.site}${path}`, {method: 'HEAD'});
    const type = asset.headers.get('content-type') ?? '';
    if (asset.status !== 200 || type.startsWith('text/html')) {
      problems.push(
        `renderer references ${path} but the site answers ${asset.status} ${type || '(no content-type)'} — ` +
          'direct profile loads cannot boot the app',
      );
    }
  }
  return problems;
}
