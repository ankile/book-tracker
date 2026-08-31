import type {
  PublicProfile,
  PublicProfileLink,
} from "./decoders";

const ORIGIN = "https://book.ankile.com";
const PROFILE_CARD = `${ORIGIN}/social/profile-card.jpg`;
const TITLE_MARKER = '<title data-shell-title>Personal Book Tracker</title>';
const DESCRIPTION_MARKER = [
  '<meta',
  '\t\t\tdata-shell-description',
  '\t\t\tname="description"',
  '\t\t\tcontent="The Book Tracker lets you keep track of your reading and provides helpful estimates of how long a book will take to finish."',
  '\t\t/>',
].join("\n");
const HEAD_MARKER = '\t\t<meta data-profile-head-slot content="" />';
const SNAPSHOT_MARKER = '\t\t<div id="profile-snapshot-slot"></div>';

const LINK_TYPE_NAMES: Record<PublicProfileLink["type"], string> = {
  twitter: "Twitter",
  github: "GitHub",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  scholar: "Google Scholar",
  goodreads: "Goodreads",
  strava: "Strava",
  homepage: "Personal homepage",
  other: "Other",
};

const LINK_PREFIXES: Record<PublicProfileLink["type"], string> = {
  twitter: "https://twitter.com/",
  github: "https://github.com/",
  linkedin: "https://www.linkedin.com/in/",
  instagram: "https://www.instagram.com/",
  scholar: "https://scholar.google.com/citations?user=",
  goodreads: "https://www.goodreads.com/",
  strava: "https://www.strava.com/athletes/",
  homepage: "https://",
  other: "https://",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function replaceExactlyOnce(
  source: string,
  marker: string,
  replacement: string,
): string {
  const first = source.indexOf(marker);
  if (first === -1 || source.indexOf(marker, first + marker.length) !== -1) {
    throw new Error(`profile shell must contain exactly one ${marker}`);
  }
  return source.slice(0, first) + replacement +
    source.slice(first + marker.length);
}

function displayName(profile: PublicProfile): string {
  return [profile.givenName.trim(), profile.familyName.trim()]
    .filter((part) => part !== "")
    .join(" ") || profile.username;
}

function profileDescription(profile: PublicProfile): string {
  const name = displayName(profile);
  return `${name} has finished ${profile.stats.finishedBooks.toLocaleString("en-US")} books and read ${profile.stats.totalPagesRead.toLocaleString("en-US")} pages.`;
}

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function linkHref(link: PublicProfileLink): string {
  if (/^https?:\/\//i.test(link.value)) return link.value;
  return LINK_PREFIXES[link.type] + link.value.replace(/^@/, "");
}

function linkName(link: PublicProfileLink): string {
  return link.type === "other" && link.label?.trim()
    ? link.label.trim()
    : LINK_TYPE_NAMES[link.type];
}

function renderLinks(links: PublicProfileLink[]): string {
  if (links.length === 0) return "";
  const rows = links.map((link) => {
    const href = escapeHtml(linkHref(link));
    const name = escapeHtml(linkName(link));
    return `<li><a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${name}</a></li>`;
  }).join("");
  return `<ul class="profile-snapshot-links" aria-label="Profile links">${rows}</ul>`;
}

function renderStats(profile: PublicProfile): string {
  const stats = [
    ["Books read", profile.stats.finishedBooks.toLocaleString("en-US")],
    ["Currently reading", profile.stats.readingBooks.toLocaleString("en-US")],
    ["Authors", profile.stats.authors.toLocaleString("en-US")],
    ["Reading time", `${profile.stats.totalTimeReadHours.toLocaleString("en-US")} hrs`],
    ["Pages read", profile.stats.totalPagesRead.toLocaleString("en-US")],
    ["Books per year", profile.stats.booksPerYear.toLocaleString("en-US")],
    ["Total books", profile.stats.totalBooks.toLocaleString("en-US")],
  ];
  return stats.map(([label, value]) => [
    '<div class="profile-snapshot-stat">',
    `<span>${escapeHtml(label)}</span>`,
    `<strong>${escapeHtml(value)}</strong>`,
    "</div>",
  ].join("")).join("");
}

function renderYears(profile: PublicProfile): string {
  if (profile.years.length === 0) return "";
  const rows = profile.years.map((year) => [
    "<tr>",
    `<td>${year.year.toLocaleString("en-US", {useGrouping: false})}</td>`,
    `<td>${year.count.toLocaleString("en-US")}</td>`,
    `<td>${year.hours.toLocaleString("en-US")}</td>`,
    `<td>${year.pages.toLocaleString("en-US")}</td>`,
    "</tr>",
  ].join("")).join("");
  return [
    '<section class="profile-snapshot-years">',
    "<h2>Books by year</h2>",
    "<table><thead><tr><th>Year</th><th>Books</th><th>Hours</th><th>Pages</th></tr></thead>",
    `<tbody>${rows}</tbody></table>`,
    "</section>",
  ].join("");
}

function renderActivity(profile: PublicProfile): string {
  if (profile.days.length === 0) return "";
  const pages = profile.days.reduce((total, day) => total + day.pagesRead, 0);
  const sessions = profile.days.reduce((total, day) => total + day.sessions, 0);
  return [
    '<section class="profile-snapshot-activity">',
    "<h2>Reading activity</h2>",
    `<p>${profile.days.length.toLocaleString("en-US")} active days, ${sessions.toLocaleString("en-US")} sessions, and ${pages.toLocaleString("en-US")} pages recorded.</p>`,
    "</section>",
  ].join("");
}

function snapshotStyles(): string {
  return `<style>
    #profile-snapshot-slot{min-height:100vh;background:#fff;color:#333;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .profile-snapshot-bar{display:flex;align-items:center;justify-content:space-between;padding:.6rem 1rem;background:#212529;color:#fff}
    .profile-snapshot-bar a{padding:.35rem 1rem;border:1px solid #ffffff80;border-radius:5px;color:#fff;font-weight:600;text-decoration:none}
    .profile-snapshot{max-width:1200px;margin:0 auto;padding:2rem}
    .profile-snapshot header{max-width:820px;margin:0 auto 2rem;padding:2.25rem 2rem 2rem;text-align:center;border:1px solid #e9e9e9;border-radius:12px;box-shadow:0 8px 28px #00000014}
    .profile-snapshot h1{margin:0;font-size:clamp(1.8rem,4vw,2.35rem)}
    .profile-snapshot-handle{margin:.55rem 0 0;color:#6f6f6f}
    .profile-snapshot-summary{color:#555}
    .profile-snapshot-links{display:flex;justify-content:center;flex-wrap:wrap;gap:.6rem;margin:1.25rem 0 0;padding:0;list-style:none}
    .profile-snapshot-links a{display:inline-block;padding:.55rem .8rem;border:1px solid #dedede;border-radius:999px;color:#333;font-size:.88rem;font-weight:600;text-decoration:none}
    .profile-snapshot-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1rem;margin-bottom:2rem}
    .profile-snapshot-stat{display:flex;flex-direction:column;gap:.3rem;padding:1.25rem;background:#fff;border-radius:5px;box-shadow:0 4px 12px #0000001a}
    .profile-snapshot-stat span{color:#666;font-size:.78rem;font-weight:600;text-transform:uppercase}
    .profile-snapshot-stat strong{font-size:1.55rem}
    .profile-snapshot-activity,.profile-snapshot-years{margin-bottom:2rem;padding:1.5rem;background:#fff;border-radius:5px;box-shadow:0 4px 12px #0000001a}
    .profile-snapshot h2{margin-top:0;font-size:1.35rem}
    .profile-snapshot table{width:100%;border-collapse:collapse}
    .profile-snapshot th,.profile-snapshot td{padding:.75rem;border-bottom:1px solid #e0e0e0;text-align:left}
    @media(max-width:600px){.profile-snapshot{padding:1rem}.profile-snapshot header{padding:1.75rem 1rem}.profile-snapshot-years{overflow-x:auto}}
  </style>`;
}

function renderSnapshot(profile: PublicProfile): string {
  const name = escapeHtml(displayName(profile));
  const handle = escapeHtml(profile.username);
  const description = escapeHtml(profileDescription(profile));
  return [
    snapshotStyles(),
    '<div class="profile-snapshot-bar"><strong>Book Tracker</strong><a href="/">Go to app</a></div>',
    '<main class="profile-snapshot">',
    "<header>",
    `<h1>${name}</h1>`,
    `<p class="profile-snapshot-handle">@${handle}</p>`,
    `<p class="profile-snapshot-summary">${description}</p>`,
    renderLinks(profile.links),
    "</header>",
    `<section class="profile-snapshot-stats" aria-label="Reading statistics">${renderStats(profile)}</section>`,
    renderActivity(profile),
    renderYears(profile),
    "</main>",
  ].join("");
}

function profileHead(profile: PublicProfile, searchable: boolean): string {
  const name = displayName(profile);
  const title = `${name}'s reading profile | Book Tracker`;
  const description = profileDescription(profile);
  const canonical = `${ORIGIN}/profiles/${profile.username}`;
  const robots = searchable
    ? "index,follow,max-image-preview:large"
    : "noindex,follow";
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    "@id": `${canonical}#profile-page`,
    url: canonical,
    name: title,
    description,
    dateModified: profile.updatedAt.toDate().toISOString(),
    mainEntity: {
      "@type": "Person",
      "@id": `${canonical}#person`,
      name,
      alternateName: `@${profile.username}`,
      url: canonical,
      sameAs: profile.links.map(linkHref),
    },
  };
  return [
    `<meta data-server-profile-meta name="robots" content="${robots}" />`,
    `<link data-server-profile-meta rel="canonical" href="${escapeHtml(canonical)}" />`,
    '<meta data-server-profile-meta property="og:type" content="profile" />',
    '<meta data-server-profile-meta property="og:site_name" content="Book Tracker" />',
    `<meta data-server-profile-meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta data-server-profile-meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta data-server-profile-meta property="og:url" content="${escapeHtml(canonical)}" />`,
    `<meta data-server-profile-meta property="profile:username" content="${escapeHtml(profile.username)}" />`,
    `<meta data-server-profile-meta property="og:image" content="${PROFILE_CARD}" />`,
    `<meta data-server-profile-meta property="og:image:secure_url" content="${PROFILE_CARD}" />`,
    '<meta data-server-profile-meta property="og:image:type" content="image/jpeg" />',
    '<meta data-server-profile-meta property="og:image:width" content="1200" />',
    '<meta data-server-profile-meta property="og:image:height" content="630" />',
    '<meta data-server-profile-meta property="og:image:alt" content="Book Tracker reading profile" />',
    '<meta data-server-profile-meta name="twitter:card" content="summary_large_image" />',
    `<meta data-server-profile-meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta data-server-profile-meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta data-server-profile-meta name="twitter:image" content="${PROFILE_CARD}" />`,
    '<meta data-server-profile-meta name="twitter:image:alt" content="Book Tracker reading profile" />',
    `<script data-server-profile-meta type="application/ld+json">${jsonForHtml(structuredData)}</script>`,
  ].join("\n\t\t");
}

export function renderProfileDocument(
  shell: string,
  profile: PublicProfile,
  searchable: boolean,
  publicView: unknown,
): string {
  const title = `${displayName(profile)}'s reading profile | Book Tracker`;
  const description = profileDescription(profile);
  let document = replaceExactlyOnce(
    shell,
    TITLE_MARKER,
    `<title data-shell-title>${escapeHtml(title)}</title>`,
  );
  document = replaceExactlyOnce(
    document,
    DESCRIPTION_MARKER,
    `<meta data-shell-description name="description" content="${escapeHtml(description)}" />`,
  );
  document = replaceExactlyOnce(document, HEAD_MARKER, `\t\t${profileHead(profile, searchable)}`);
  // The profile data, inlined so a fresh page load hydrates the SPA without
  // the /profiles/<username>.json round trip that showed a "Loading…" flash
  // on every refresh. Same wire shape as that endpoint; jsonForHtml escapes
  // it so a value containing </script> cannot break out. It lives inside the
  // snapshot slot (not between it and #app-shell) so the no-JS
  // adjacent-sibling CSS and the client's consume-and-clear both still hold.
  return replaceExactlyOnce(
    document,
    SNAPSHOT_MARKER,
    `\t\t<div id="profile-snapshot-slot">${renderSnapshot(profile)}`
    + `<script id="profile-bootstrap" type="application/json">${jsonForHtml(publicView)}</script></div>`,
  );
}

export function renderNotFoundDocument(shell: string): string {
  const title = "Profile not found | Book Tracker";
  let document = replaceExactlyOnce(
    shell,
    TITLE_MARKER,
    `<title data-shell-title>${title}</title>`,
  );
  document = replaceExactlyOnce(
    document,
    DESCRIPTION_MARKER,
    '<meta data-shell-description name="description" content="This Book Tracker profile is unavailable." />',
  );
  document = replaceExactlyOnce(
    document,
    HEAD_MARKER,
    '\t\t<meta data-server-profile-meta name="robots" content="noindex,nofollow" />',
  );
  const snapshot = [
    snapshotStyles(),
    '<div class="profile-snapshot-bar"><strong>Book Tracker</strong><a href="/">Go to app</a></div>',
    '<main class="profile-snapshot"><p>This profile was not found.</p></main>',
  ].join("");
  return replaceExactlyOnce(
    document,
    SNAPSHOT_MARKER,
    `\t\t<div id="profile-snapshot-slot">${snapshot}</div>`,
  );
}

export interface SitemapProfile {
  username: string;
  updatedAt: Date;
}

function escapeXml(value: string): string {
  return escapeHtml(value);
}

export function renderSitemap(profiles: SitemapProfile[]): string {
  const rows = [...profiles]
    .sort((left, right) => left.username.localeCompare(right.username))
    .map((profile) => [
      "  <url>",
      `    <loc>${escapeXml(`${ORIGIN}/profiles/${profile.username}`)}</loc>`,
      `    <lastmod>${profile.updatedAt.toISOString()}</lastmod>`,
      "  </url>",
    ].join("\n"))
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    rows,
    "</urlset>",
    "",
  ].join("\n");
}
