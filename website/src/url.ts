/** A path on this site, under the base GitHub Pages serves it at: url('docs/') is /sosie/docs/. */
export function url(path = ''): string {
  return import.meta.env.BASE_URL.replace(/\/?$/, '/') + path.replace(/^\//, '');
}

export const REPO = 'https://github.com/monkilabs/sosie';
export const NPM = 'https://www.npmjs.com/package/@sosie/cli';
