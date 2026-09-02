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
  // pdfjs-dist's legacy Node build loads @napi-rs/canvas via a dynamically
  // constructed require(), which the standalone output's file tracer can't
  // statically follow — force it (and its platform-specific native binding
  // package, e.g. @napi-rs/canvas-linux-x64-musl) into the trace. Same story
  // for pdf.worker.mjs: even with disableWorker:true, pdfjs-dist's Node
  // fake-worker fallback dynamically imports it, so it must be shipped too.
  outputFileTracingIncludes: {
    "/*": [
      "node_modules/@napi-rs/canvas*/**/*",
      "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    ],
  },
  // Allow ~21 MB portfolio PDFs (Nature of Code) through App Router form posts.
  experimental: {
    proxyClientMaxBodySize: "25mb",
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
};

export default nextConfig;
