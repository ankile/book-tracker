// `npm run release:verify`: confirm the live profile renderer and the live
// site were both released from this commit and agree on the app bundle.
// See release-check.ts for what is checked and why.
import {readFile} from 'node:fs/promises';
import {verifyRelease} from './release-check.ts';

const shell = await readFile(new URL('./functions/assets/profile-shell.html', import.meta.url), 'utf8');
const problems = await verifyRelease(fetch, shell);
if (problems.length > 0) {
  throw new Error(`release is inconsistent:\n- ${problems.join('\n- ')}`);
}
console.log('release verified: the renderer, the site and HEAD reference the same bundle');
