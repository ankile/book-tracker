import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	build: {
		rollupOptions: {
			output: {
				// Keep the large Firestore SDK separate from Auth and application
				// code even when shared listener wrappers change Rollup's grouping.
				manualChunks(id) {
					if (id.includes('/node_modules/@firebase/firestore/')) return 'firebase-firestore';
				}
			}
		}
	}
});
