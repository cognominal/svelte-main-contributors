import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: true
	},
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter()
	},
	vitePlugin: {
		inspector: {
			toggleKeyCombo: 'control-shift',
			holdMode: false,
		}
	}
};

export default config;
