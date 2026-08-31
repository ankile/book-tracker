import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import type { Config } from '@sveltejs/kit';

const verificationVersion = process.env.BOOK_TRACKER_BUILD_VERSION;

// Emulator suites (VITE_EMULATOR=1, set by playwright.config.ts and the
// README's emulator dev loop) talk to local Auth/Firestore/Functions
// emulators on their own ports — different origins, so connect-src must
// name them there. Production builds never set the variable, so the
// shipped policy contains no loopback origin.
const emulatorConnectSrc: (`http://127.0.0.1:${number}` | `ws://127.0.0.1:${number}`)[] =
	process.env.VITE_EMULATOR
		? ['http://127.0.0.1:9099', 'http://127.0.0.1:8080', 'http://127.0.0.1:5001', 'ws://127.0.0.1:8080']
		: [];

const config: Config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		// Normal deploy builds keep SvelteKit's rotating version. The artifact
		// test pins this to the committed version so it can prove a clean
		// rebuild is byte-for-byte current despite SvelteKit's random default.
		...(verificationVersion === undefined
			? {}
			: { version: { name: verificationVersion } }),
		// adapter-static for Firebase Hosting
		adapter: adapter({
			// Output directory for Firebase
			pages: 'public',
			assets: 'public',
			fallback: 'index.html',
			precompress: false,
			strict: true
		}),
		prerender: {
			handleHttpError: 'warn'
		},
		// SEC-007. Hash mode: SvelteKit puts this policy in a <meta> tag on the
		// prerendered pages (index.html, the SPA fallback, and via
		// sync-profile-shell.ts every function-rendered profile page) with the
		// sha256 of its own inline bootstrap script; the first hash below is
		// app.html's classList script. No 'unsafe-inline' for scripts — an
		// injected <script> does not run. frame-ancestors cannot live in a
		// meta tag; firebase.json and publicWeb.ts carry it as a header.
		csp: {
			mode: 'hash',
			directives: {
				'default-src': ['self'],
				'script-src': [
					'self',
					'sha256-/x7W7R75k8Roq0WaVRQX9blP4OufE5xbAdzklGxsgpw=',
					'https://www.google.com/recaptcha/',
					'https://www.gstatic.com/recaptcha/',
					// Cloudflare Web Analytics beacon, injected at the edge into HTML
					// served through book.ankile.com (owner decision 2026-08-31);
					// cookieless, reports to cloudflareinsights.com below.
					'https://static.cloudflareinsights.com'
				],
				// 41 style="" attributes in components and the profile snapshot's
				// <style> block; style injection is a cosmetic vector, scripts are
				// the one that matters.
				'style-src': ['self', 'unsafe-inline'],
				// Covers come from whatever host the metadata source names
				// (five origins in prod today); pinning them would break the next
				// source. https-only is the meaningful line.
				'img-src': ['self', 'data:', 'https:'],
				'font-src': ['self'],
				'connect-src': [
					'self',
					'https://firestore.googleapis.com',
					'https://identitytoolkit.googleapis.com',
					'https://securetoken.googleapis.com',
					'https://firebaseinstallations.googleapis.com',
					'https://content-firebaseappcheck.googleapis.com',
					'https://firebaseappcheck.googleapis.com',
					'https://europe-west1-book-tracker-d8f24.cloudfunctions.net',
					'https://api.nb.no',
					'https://openlibrary.org',
					'https://www.google.com/recaptcha/',
					'https://cloudflareinsights.com',
					...emulatorConnectSrc
				],
				'frame-src': [
					'https://www.google.com/recaptcha/',
					'https://recaptcha.google.com/recaptcha/'
				],
				'worker-src': ['self'],
				'manifest-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['none'],
				'form-action': ['self']
			}
		}
	}
};

export default config;
