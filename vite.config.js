import { defineConfig } from 'vite';

export default defineConfig({
  base: '/ashi-at/',

  build: {
    // Vite 8のデフォルトCSSミニファイア(lightningcss)には、同じ宣言内に
    // 標準プロパティ(backdrop-filter)とベンダープレフィックス版
    // (-webkit-backdrop-filter)を両方書くと「同じプロパティの重複」とみなし、
    // 後に書いた方(-webkit-版)だけを残して標準プロパティを消してしまう
    // 既知のバグがある(https://github.com/vitejs/vite/issues/22649,
    // 上流: https://github.com/parcel-bundler/lightningcss/issues/695)。
    // Chrome/FirefoxはWebKit接頭辞を理解しないため、すりガラス効果
    // (backdrop-filter)が本番ビルドでのみ効かなくなる(devサーバでは
    // このミニファイアを通らないため再現しない)。対象ブラウザ指定でも
    // 解消しないとのことなので、CSSミニファイアをesbuild(Vite 7までの既定)
    // に固定して回避する。
    cssMinify: 'esbuild',
  },

  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Dev-only: forwards /api/* to misskey.io. Not present in `vite build`
      // output — the deployed app still talks to Misskey directly from the
      // browser, per README_JP.md's no-backend-proxy policy.
      '/api': {
        target: 'https://misskey.io',
        changeOrigin: true,
        // changeOrigin only rewrites the Host header — Origin/Referer
        // (http://localhost:5173/...) were still forwarded as-is, so
        // Cloudflare kept seeing a localhost origin even through the
        // proxy. Strip them so the upstream request looks like a plain
        // server-to-server call.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin');
            proxyReq.removeHeader('referer');
          });
        },
      },
    },
  },
});
