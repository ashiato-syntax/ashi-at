import { defineConfig } from 'vite';

export default defineConfig({
  server: {
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
