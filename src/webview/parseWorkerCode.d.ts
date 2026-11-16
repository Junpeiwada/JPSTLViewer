// esbuild.mjs が束ねた Worker の JS（文字列）
declare module 'parse-worker-code' {
  const code: string;
  export default code;
}
