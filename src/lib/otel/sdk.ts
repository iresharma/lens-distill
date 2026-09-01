import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes, defaultResource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_K8S_NAMESPACE_NAME,
} from "@opentelemetry/semantic-conventions/incubating";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";

import pkg from "../../../package.json";

type GlobalWithOtel = typeof globalThis & { __otelSdk?: NodeSDK };
const g = globalThis as GlobalWithOtel;

/** Boots the Node OTel SDK (traces + metrics + logs) exporting via OTLP to SigNoz. */
export async function startOtel(): Promise<void> {
  if (g.__otelSdk) return; // already started (Next dev hot-reload re-invokes register())
  if ((process.env.OTEL_SDK_DISABLED || "").toLowerCase() === "true") return;

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
  const serviceName = process.env.OTEL_SERVICE_NAME || "lens-distill";
  const serviceNamespace = process.env.OTEL_SERVICE_NAMESPACE || "lens-distill";
  const deploymentEnv =
    process.env.OTEL_DEPLOYMENT_ENVIRONMENT || "development";
  const k8sNamespace = process.env.K8S_NAMESPACE;

  const resource = defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_NAMESPACE]: serviceNamespace,
      [ATTR_SERVICE_VERSION]: pkg.version,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: deploymentEnv,
      ...(k8sNamespace ? { [ATTR_K8S_NAMESPACE_NAME]: k8sNamespace } : {}),
    }),
  );

  const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
  const metricExporter = new OTLPMetricExporter({
    url: `${endpoint}/v1/metrics`,
  });
  const logExporter = new OTLPLogExporter({ url: `${endpoint}/v1/logs` });

  const sdk = new NodeSDK({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 15_000,
      }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({ exporter: logExporter }),
    ],
    instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
  });

  sdk.start();
  g.__otelSdk = sdk;

  const { registerQuotaGauge } = await import("./meter");
  registerQuotaGauge();

  process.on("SIGTERM", () => {
    void shutdownOtel();
  });
}

/** Flushes all pending spans/metrics/logs and stops the SDK. Await before process.exit(). */
export async function shutdownOtel(): Promise<void> {
  const sdk = g.__otelSdk;
  if (!sdk) return;
  g.__otelSdk = undefined;
  await sdk.shutdown().catch(() => {});
}
