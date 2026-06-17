// OpenTelemetry bootstrap for the Copilot SDK API.
//
// When APPLICATIONINSIGHTS_CONNECTION_STRING is present (set by Bicep in Azure),
// this wires the API into Azure Monitor / Application Insights. Incoming HTTP,
// outgoing fetch to the Foundry agent, and our custom tool spans then appear as
// one distributed trace — alongside the Foundry hosted agent's own traces, which
// the platform emits automatically. That end-to-end view (web → API → tool →
// Foundry agent) is the observability story in the demo.
//
// Import this module FIRST (before any instrumented library) so auto-
// instrumentation can hook in. It is a no-op when the connection string is
// absent, so local development is unaffected.

import { useAzureMonitor } from "@azure/monitor-opentelemetry";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";

const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

if (connectionString) {
  useAzureMonitor({
    azureMonitorExporterOptions: { connectionString },
    samplingRatio: 1,
  });
  // eslint-disable-next-line no-console
  console.log("✓ Azure Monitor OpenTelemetry enabled (Application Insights).");
} else {
  // eslint-disable-next-line no-console
  console.log("ℹ APPLICATIONINSIGHTS_CONNECTION_STRING not set — telemetry disabled (local dev).");
}

const tracer = trace.getTracer("contoso-markets-assistant");

/**
 * Run `fn` inside a span named `tool.<name>` so each custom tool invocation
 * shows up in the trace as a distinct operation with its arguments and outcome.
 */
export async function withToolSpan<T>(
  toolName: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(`tool.${toolName}`, async (span: Span) => {
    span.setAttribute("tool.name", toolName);
    for (const [k, v] of Object.entries(attributes)) {
      span.setAttribute(`tool.arg.${k}`, v);
    }
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
