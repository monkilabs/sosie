import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// GitHub Pages serves the site under the repository's name. With a domain of
// its own, set site to it, drop base, and add public/CNAME.
export default defineConfig({
  site: 'https://monkilabs.github.io',
  base: '/sosie',
  trailingSlash: 'always',
  integrations: [sitemap()],
  markdown: {
    shikiConfig: { theme: 'github-dark-dimmed' },
  },
});
