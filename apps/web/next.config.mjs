/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@proofwork/crypto", "@proofwork/shared"],
  // Allows importing read-only fixtures from ../../spec (persona picker).
  experimental: { externalDir: true },
};
export default nextConfig;
