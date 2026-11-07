/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@proofwork/crypto", "@proofwork/shared"],
  // Allows importing read-only fixtures from ../../spec (persona picker).
  experimental: { externalDir: true },
  // Same-origin proxy to the API, so one public tunnel to the web app serves the whole demo
  // (set NEXT_PUBLIC_API_BASE=/pw-api to use it).
  async rewrites() {
    return [
      { source: "/pw-api/:path*", destination: `${process.env.API_PROXY_TARGET ?? "http://localhost:8787"}/:path*` },
      // GitHub webhooks reach the ingest service (apps/ingest, HMAC-checked on the raw body) through the same tunnel.
      { source: "/ingest/webhooks/github", destination: `${process.env.INGEST_PROXY_TARGET ?? "http://localhost:8788"}/webhooks/github` },
    ];
  },
};
export default nextConfig;
