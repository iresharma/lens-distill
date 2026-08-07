import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  serverExternalPackages: [
    "@neondatabase/serverless",
    "ws",
    "pdfjs-dist",
    "js-tiktoken",
  ],
  // Allow ~21 MB portfolio PDFs (Nature of Code) through App Router form posts.
  experimental: {
    proxyClientMaxBodySize: "25mb",
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
};

export default nextConfig;
