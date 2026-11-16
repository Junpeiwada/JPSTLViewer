// webview 側（Three.js）を 1 本の JS に束ねる。
// 拡張を CDN に依存させず、オフラインでも動かすため。
import * as esbuild from 'esbuild';
import * as path from 'node:path';

const watch = process.argv.includes('--watch');

/**
 * 解析の Worker（src/webview/parseWorker.ts）を別に束ね、その JS を文字列として main.ts に埋め込む。
 * main.ts は `import code from 'parse-worker-code'` で受け取り、blob から Worker を起動する。
 * 別ファイルで配ると webview から読むのに CSP の connect-src が要り、HTML と JS の版ずれにも弱いので、1 本にまとめる
 */
const parseWorkerPlugin = {
  name: 'parse-worker-code',
  setup(build) {
    build.onResolve({ filter: /^parse-worker-code$/ }, (args) => ({ path: args.path, namespace: 'parse-worker-code' }));
    build.onLoad({ filter: /.*/, namespace: 'parse-worker-code' }, async () => {
      const result = await esbuild.build({
        entryPoints: ['src/webview/parseWorker.ts'],
        bundle: true,
        format: 'iife',
        target: 'es2020',
        minify: !watch,
        write: false,
        metafile: true,
        logLevel: 'warning', // Worker 側の警告・エラーも出す
      });
      return {
        contents: `export default ${JSON.stringify(result.outputFiles[0].text)};`,
        loader: 'js',
        // Worker 側のファイルを直したときも watch で束ね直す
        watchFiles: Object.keys(result.metafile.inputs).map((f) => path.resolve(f)),
      };
    });
  },
};

const options = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  sourcemap: false,
  outfile: 'media/webview.js',
  logLevel: 'info',
  plugins: [parseWorkerPlugin],
};

if (watch) {
  const ctx = await esbuild.context({ ...options, minify: false, sourcemap: 'inline' });
  await ctx.watch();
} else {
  await esbuild.build(options);
}
