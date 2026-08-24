// Public links can contain a full URL or a bare handle. Bare handles get
// the platform prefix. Simple Icons provides current service marks where
// available; svelte-awesome covers LinkedIn and generic link types.
import {
  twitter, github, linkedin, instagram,
  graduationCap, book, bicycle, globe, link as chainLink,
} from 'svelte-awesome/icons';
import {
  siGithub, siInstagram, siGooglescholar, siGoodreads, siStrava,
} from 'simple-icons';
import type { ProfileLink, ProfileLinkType } from '../interfaces/profile.ts';

interface LinkTypeDefinition {
  type: ProfileLinkType;
  name: string;
  prefix: string;
  icon: typeof twitter;
  brandIcon?: typeof siGithub;
}

export const LINK_TYPES: readonly LinkTypeDefinition[] = [
  { type: 'twitter', name: 'Twitter', prefix: 'https://twitter.com/', icon: twitter },
  { type: 'github', name: 'GitHub', prefix: 'https://github.com/', icon: github, brandIcon: siGithub },
  { type: 'linkedin', name: 'LinkedIn', prefix: 'https://www.linkedin.com/in/', icon: linkedin },
  { type: 'instagram', name: 'Instagram', prefix: 'https://www.instagram.com/', icon: instagram, brandIcon: siInstagram },
  { type: 'scholar', name: 'Google Scholar', prefix: 'https://scholar.google.com/citations?user=', icon: graduationCap, brandIcon: siGooglescholar },
  { type: 'goodreads', name: 'Goodreads', prefix: 'https://www.goodreads.com/', icon: book, brandIcon: siGoodreads },
  { type: 'strava', name: 'Strava', prefix: 'https://www.strava.com/athletes/', icon: bicycle, brandIcon: siStrava },
  { type: 'homepage', name: 'Personal homepage', prefix: 'https://', icon: globe },
  { type: 'other', name: 'Other', prefix: 'https://', icon: chainLink },
];

// Matches the cap in firestore.rules.
export const MAX_PROFILE_LINKS = 10;

function byType(type: ProfileLinkType): LinkTypeDefinition {
  const definition = LINK_TYPES.find((entry) => entry.type === type);
  if (definition === undefined) throw new Error(`Missing profile link definition: ${type}`);
  return definition;
}

export function linkIcon(link: ProfileLink): typeof twitter {
  return byType(link.type).icon;
}

export function linkBrandIcon(link: ProfileLink): typeof siGithub | null {
  return byType(link.type).brandIcon ?? null;
}

export function linkTypeName(link: ProfileLink): string {
  if (link.type === 'other' && link.label) return link.label;
  return byType(link.type).name;
}

// Full http(s) URLs pass through; anything else is treated as a handle
// and appended to the platform prefix (leading @ stripped). A value can
// therefore never smuggle in its own scheme — a hostile "javascript:…"
// just becomes a dead https link.
export function linkHref(link: ProfileLink): string {
  if (/^https?:\/\//i.test(link.value)) return link.value;
  const prefix = byType(link.type).prefix;
  return prefix + link.value.replace(/^@/, '');
}

// What the public page prints next to the icon: the custom label for
// "other" when set, else the value with the scheme noise stripped.
export function linkDisplay(link: ProfileLink): string {
  if (link.type === 'other' && link.label) return link.label;
  return link.value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}
