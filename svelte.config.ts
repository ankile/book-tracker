import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import type { Config } from '@sveltejs/kit';

const verificationVersion = process.env.BOOK_TRACKER_BUILD_VERSION;

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
		}
	}
};

export default config;
