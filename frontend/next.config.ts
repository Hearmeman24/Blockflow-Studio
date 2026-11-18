import type { NextConfig } from "next";

const backendPort = process.env.BACKEND_PORT || "8000";

// How long the /api and /outputs proxy waits for the backend, in seconds.
// Next.js drops a proxied request after `experimental.proxyTimeout` ms (30 s
// when unset), which the browser sees as a bare HTTP 500. This must stay
// above every synchronous backend request so the backend always answers
// first with its own error: the Prompt Writer (600 s for local models,
// backend/prompt_writer/service.py) and the Video FX / Video Stitcher runs,
// whose single steps may take up to 2 h (RIFE) and whose whole run for one
// video can take about 3 h. tests/test_proxy_timeout.py checks this.
const PROXY_TIMEOUT_S = 14_400;

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    externalDir: true,
    // Block upload endpoints (video_loader etc.) stream raw file bytes
    // through the /api rewrite; the proxy's default 10MB body cap truncates
    // larger videos mid-request.
    proxyClientMaxBodySize: "100mb",
    // Milliseconds. Read by the router server of both `next dev` and the
    // standalone production server (next/dist/server/lib/router-server.js).
    proxyTimeout: PROXY_TIMEOUT_S * 1000,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://127.0.0.1:${backendPort}/api/:path*`,
      },
      {
        source: "/outputs/:path*",
        destination: `http://127.0.0.1:${backendPort}/outputs/:path*`,
      },
    ];
  },
};

export default nextConfig;
