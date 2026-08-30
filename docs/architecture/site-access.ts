import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type AccessKind = 'owner' | 'public' | 'privileged';

interface AccessRow {
  name: string;
  path: string;
  reached: string[];
  read: string[];
  readKind: AccessKind;
  writes: string[];
  writeKind?: 'privileged';
}

interface TextOptions {
  fill?: string;
  fontSize?: number;
  weight?: number;
  family?: string;
  lineHeight?: number;
}

const rows: AccessRow[] = [
  {
    name: 'Currently Reading',
    path: '/',
    reached: ['Navbar · My site card · direct URL', "Profile 'Go to app' link"],
    read: ['Owner'],
    readKind: 'owner',
    writes: ['Books · authors · page updates', 'Sessions · reading timers'],
  },
  {
    name: 'Finished',
    path: '/finished',
    reached: ['Navbar · My site card · direct URL'],
    read: ['Owner'],
    readKind: 'owner',
    writes: ['Books · authors · page updates', 'Reading sessions'],
  },
  {
    name: 'My site',
    path: '/me',
    reached: ['Navbar · direct URL'],
    read: ['Owner'],
    readKind: 'owner',
    writes: ['Add book · sharing settings', 'Profile links · optional integrations'],
  },
  {
    name: 'Authors',
    path: '/authors',
    reached: ['My site Authors card · direct URL'],
    read: ['Owner'],
    readKind: 'owner',
    writes: ['Authors · book author references', 'Delete is stored as retirement'],
  },
  {
    name: 'Book metadata',
    path: '/isbns',
    reached: ['My site ISBN card · direct URL'],
    read: ['Owner'],
    readKind: 'owner',
    writes: ['Book metadata and authors', 'Through the edit-book dialog'],
  },
  {
    name: 'Reading profile',
    path: '/profiles/[username]',
    reached: ['My site link · shared URL', 'Search result · direct URL'],
    read: ['Anyone when published', 'Owner when private'],
    readKind: 'public',
    writes: ['None on this page', 'Owner edits profile on /me'],
  },
  {
    name: 'Admin overview',
    path: '/admin',
    reached: ['Direct URL only'],
    read: ['Authorized operator'],
    readKind: 'privileged',
    writes: ['No page editing', 'Operational access may be audited'],
    writeKind: 'privileged',
  },
];

const palette = {
  ink: '#263331',
  muted: '#52615e',
  line: '#c9d1cf',
  header: '#35686a',
  headerInk: '#ffffff',
  routeFill: '#e8f2f1',
  routeStroke: '#35686a',
  reachFill: '#f7f8f8',
  reachStroke: '#8b9691',
  ownerFill: '#eaf7ef',
  ownerStroke: '#2e7d55',
  publicFill: '#edf4f6',
  publicStroke: '#497789',
  writeFill: '#f4eef8',
  writeStroke: '#7d5b91',
  privilegedFill: '#fff7f6',
  privilegedStroke: '#b42318',
  noteFill: '#fff7e8',
  noteStroke: '#b98a3c',
};

const width = 1600;
const margin = 40;
const gap = 12;
const titleHeight = 112;
const headerHeight = 58;
const rowHeight = 116;
const rowGap = 10;
const noteGap = 22;
const noteHeight = 84;
const columns = [
  { key: 'route', label: 'Route', x: margin, width: 260 },
  { key: 'reached', label: 'Reached from', x: 312, width: 398 },
  { key: 'read', label: 'Read access', x: 722, width: 350 },
  { key: 'writes', label: 'Writes available', x: 1084, width: 476 },
];
const rowsTop = titleHeight + headerHeight + 14;
const noteTop = rowsTop + rows.length * rowHeight + (rows.length - 1) * rowGap + noteGap;
const height = noteTop + noteHeight + 38;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function rect(
  x: number,
  y: number,
  cellWidth: number,
  cellHeight: number,
  fill: string,
  stroke: string,
  radius = 10,
): string {
  return `<rect x="${x}" y="${y}" width="${cellWidth}" height="${cellHeight}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
}

function lines(values: string[], x: number, y: number, options: TextOptions = {}): string {
  const {
    fill = palette.ink,
    fontSize = 17,
    weight = 400,
    family = 'Arial, Helvetica, sans-serif',
    lineHeight = 25,
  } = options;
  const spans = values.map((value, index) => (
    `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(value)}</tspan>`
  )).join('');
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${fontSize}" font-weight="${weight}">${spans}</text>`;
}

function routeCell(row: AccessRow, x: number, y: number, cellWidth: number): string {
  return [
    rect(x, y, cellWidth, rowHeight, palette.routeFill, palette.routeStroke),
    lines([row.name], x + 18, y + 38, { fontSize: 18, weight: 700 }),
    lines([row.path], x + 18, y + 70, {
      fill: '#173f41',
      fontSize: 16,
      family: 'SFMono-Regular, Consolas, Liberation Mono, monospace',
    }),
  ].join('');
}

function standardCell(
  values: string[],
  x: number,
  y: number,
  cellWidth: number,
  fill: string,
  stroke: string,
): string {
  const firstY = y + (values.length === 1 ? 64 : 48);
  return [
    rect(x, y, cellWidth, rowHeight, fill, stroke),
    lines(values, x + 18, firstY, { fontSize: 17, lineHeight: 27 }),
  ].join('');
}

function readColors(kind: AccessKind): [string, string] {
  if (kind === 'public') return [palette.publicFill, palette.publicStroke];
  if (kind === 'privileged') return [palette.privilegedFill, palette.privilegedStroke];
  return [palette.ownerFill, palette.ownerStroke];
}

const headers = columns.map((column) => [
  rect(column.x, titleHeight, column.width, headerHeight, palette.header, palette.header, 9),
  lines([column.label], column.x + 18, titleHeight + 37, {
    fill: palette.headerInk,
    fontSize: 18,
    weight: 700,
  }),
].join('')).join('');

const body = rows.map((row, index) => {
  const y = rowsTop + index * (rowHeight + rowGap);
  const [readFill, readStroke] = readColors(row.readKind);
  const writeFill = row.writeKind === 'privileged' ? palette.privilegedFill : palette.writeFill;
  const writeStroke = row.writeKind === 'privileged' ? palette.privilegedStroke : palette.writeStroke;
  return [
    routeCell(row, columns[0].x, y, columns[0].width),
    standardCell(row.reached, columns[1].x, y, columns[1].width, palette.reachFill, palette.reachStroke),
    standardCell(row.read, columns[2].x, y, columns[2].width, readFill, readStroke),
    standardCell(row.writes, columns[3].x, y, columns[3].width, writeFill, writeStroke),
  ].join('');
}).join('');

const noteWidth = width - margin * 2;
const note = [
  rect(margin, noteTop, noteWidth, noteHeight, palette.noteFill, palette.noteStroke),
  lines(['Security boundary'], margin + 18, noteTop + 32, { fontSize: 17, weight: 700 }),
  lines([
    'Route checks guide navigation. Authenticated data permissions and server-side authorization enforce access. Signed-out private routes resume after authentication.',
  ], margin + 18, noteTop + 61, { fill: palette.muted, fontSize: 16 }),
].join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title description" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title id="title">Book Tracker route access and write matrix</title>
  <desc id="description">Every route, how it is reached, who can read it, and the page or server writes available there.</desc>
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  ${lines(['Route access and writes'], margin, 48, { fill: '#173f41', fontSize: 30, weight: 700 })}
  ${lines(['Every application path, its entry points, authoritative reader, and data-changing actions'], margin, 82, { fill: palette.muted, fontSize: 17 })}
  ${headers}
  ${body}
  ${note}
</svg>
`;

writeFileSync(fileURLToPath(new URL('site-access.svg', import.meta.url)), svg);
