import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactCompiler: true,
  serverExternalPackages: [
    "pg",
    "pdfjs-dist",
    "@napi-rs/canvas",
    "js-tiktoken",
    "@opentelemetry/sdk-node",
    "@opentelemetry/sdk-logs",
    "@opentelemetry/sdk-metrics",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/resources",
    "@opentelemetry/semantic-conventions",
    "@opentelemetry/exporter-trace-otlp-proto",
    "@opentelemetry/exporter-metrics-otlp-proto",
    "@opentelemetry/exporter-prometheus",
    "@opentelemetry/exporter-logs-otlp-proto",
    "@opentelemetry/instrumentation-http",
    "@opentelemetry/instrumentation-undici",
    "@opentelemetry/context-async-hooks",
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
