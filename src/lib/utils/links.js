// Public handles a profile can list. The value is either a full URL or a
// bare handle; bare handles get the platform prefix. Icons: FA 4.7 (what
// svelte-awesome ships) has real brand marks for the first four; Scholar,
// Goodreads, and Strava get recognizable stand-in glyphs.
import {
  twitter, github, linkedin, instagram,
  graduationCap, book, bicycle, globe, link as chainLink,
} from 'svelte-awesome/icons';

export const LINK_TYPES = [
  { type: 'twitter', name: 'Twitter', prefix: 'https://twitter.com/', icon: twitter },
  { type: 'github', name: 'GitHub', prefix: 'https://github.com/', icon: github },
  { type: 'linkedin', name: 'LinkedIn', prefix: 'https://www.linkedin.com/in/', icon: linkedin },
  { type: 'instagram', name: 'Instagram', prefix: 'https://www.instagram.com/', icon: instagram },
  { type: 'scholar', name: 'Google Scholar', prefix: 'https://scholar.google.com/citations?user=', icon: graduationCap },
  { type: 'goodreads', name: 'Goodreads', prefix: 'https://www.goodreads.com/', icon: book },
  { type: 'strava', name: 'Strava', prefix: 'https://www.strava.com/athletes/', icon: bicycle },
  { type: 'homepage', name: 'Personal homepage', prefix: 'https://', icon: globe },
  { type: 'other', name: 'Other', prefix: 'https://', icon: chainLink },
];

// Matches the cap in firestore.rules.
export const MAX_PROFILE_LINKS = 10;

const byType = (type) => LINK_TYPES.find((t) => t.type === type);

export function linkIcon(link) {
  return (byType(link.type) ?? byType('other')).icon;
}

export function linkTypeName(link) {
  if (link.type === 'other' && link.label) return link.label;
  return byType(link.type)?.name ?? link.type;
}

// Full http(s) URLs pass through; anything else is treated as a handle
// and appended to the platform prefix (leading @ stripped). A value can
// therefore never smuggle in its own scheme — a hostile "javascript:…"
// just becomes a dead https link.
export function linkHref(link) {
  if (/^https?:\/\//i.test(link.value)) return link.value;
  const prefix = byType(link.type)?.prefix ?? 'https://';
  return prefix + link.value.replace(/^@/, '');
}

// What the public page prints next to the icon: the custom label for
// "other" when set, else the value with the scheme noise stripped.
export function linkDisplay(link) {
  if (link.type === 'other' && link.label) return link.label;
  return link.value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}
