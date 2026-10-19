/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {},
  // DuckDB ships platform-specific native bindings (@duckdb/node-bindings-darwin-arm64 etc.).
  // Turbopack tries to bundle them and fails resolving the other platforms' .node files,
  // so keep the whole package external (loaded at runtime via require, like any native module).
  serverExternalPackages: ['@duckdb/node-api', '@duckdb/node-bindings'],
};

export default nextConfig;
