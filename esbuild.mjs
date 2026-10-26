// webview 側（Three.js）を 1 本の JS に束ねる。
// 拡張を CDN に依存させず、オフラインでも動かすため。
import * as esbuild from 'esbuild';

const options = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  sourcemap: false,
  outfile: 'media/webview.js',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context({ ...options, minify: false, sourcemap: 'inline' });
  await ctx.watch();
} else {
  await esbuild.build(options);
}
