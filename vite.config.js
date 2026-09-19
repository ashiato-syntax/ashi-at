import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages(プロジェクトサイト)は/ashi-at/配下での公開になる一方、
  // Cloudflare(独自ドメインashi-at.netのルートで公開)はルートでの公開になる
  // ため、base(アセットの参照パス)を分ける必要がある。
  // 当初はCloudflare側で手動設定する環境変数(DEPLOY_TARGET等)で判定していたが、
  // Cloudflareの「Workers(wrangler)」ビルドはvite.config.js/wrangler.jsoncを
  // ビルドごとに使い捨てのコンテナ内で自動生成する方式で、ダッシュボードで
  // 設定したビルド用環境変数が確実にvite build側へ渡るとは限らず、実際に
  // base(/ashi-at/のまま)が反映されない不具合が起きた。
  // 代わりに、GitHub Actions実行時に必ず自動で設定される(手動設定不要かつ
  // Cloudflare側では立たないことが保証されている)GITHUB_ACTIONS変数で判定する
  // 方式に変更。GitHub Actions上でのビルドだけ/ashi-at/を使い、それ以外
  // (Cloudflareのビルド・ローカル開発時のnpm run build)は全てルート(/)にする。
  base: process.env.GITHUB_ACTIONS ? '/ashi-at/' : '/',

  plugins: [],

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
