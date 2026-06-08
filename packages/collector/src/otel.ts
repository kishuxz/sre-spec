import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { Run, Step, StepType } from "@checkpoint/core";

type AttributePrimitive = string | number | boolean;

function stringAttribute(
  attributes: ReadableSpan["attributes"],
  name: string
): string | undefined {
  const value = attributes[name];
  return typeof value === "string" ? value : undefined;
}

function numberAttribute(
  attributes: ReadableSpan["attributes"],
  name: string
): number | undefined {
  const value = attributes[name];
  return typeof value === "number" ? value : undefined;
}

function stepTypeAttribute(
  attributes: ReadableSpan["attributes"]
): StepType | undefined {
  const value = stringAttribute(attributes, "checkpoint.step.type");

  if (value === "llm_call" || value === "tool_call") {
    return value;
  }

  return undefined;
}

function jsonAttribute(
  attributes: ReadableSpan["attributes"],
  name: string
): unknown {
  const value = stringAttribute(attributes, name);

  if (!value) {
    return {};
  }

  return JSON.parse(value) as unknown;
}

function hrTimeToMs(hrTime: readonly [number, number]): number {
  const [seconds, nanoseconds] = hrTime;
  return seconds * 1000 + Math.floor(nanoseconds / 1_000_000);
}

function hrTimeToIso(hrTime: readonly [number, number]): string {
  return new Date(hrTimeToMs(hrTime)).toISOString();
}

function spanEndIso(span: ReadableSpan): string {
  return new Date(hrTimeToMs(span.startTime) + hrTimeToMs(span.duration)).toISOString();
}

function metadataFromAttributes(
  attributes: ReadableSpan["attributes"]
): Record<string, AttributePrimitive> | undefined {
  const metadata: Record<string, AttributePrimitive> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (!key.startsWith("checkpoint.metadata.")) {
      continue;
    }

    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      metadata[key.slice("checkpoint.metadata.".length)] = value;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function fromOpenTelemetrySpans(spans: readonly ReadableSpan[]): Run {
  const stepSpans = spans
    .filter((span) => stepTypeAttribute(span.attributes))
    .sort((left, right) => hrTimeToMs(left.startTime) - hrTimeToMs(right.startTime));
  const firstSpan = stepSpans[0] ?? spans[0];
  const lastSpan = stepSpans[stepSpans.length - 1] ?? spans[spans.length - 1];

  if (!firstSpan || !lastSpan) {
    throw new Error("Cannot build Run from an empty OpenTelemetry span list.");
  }

  const runId =
    stringAttribute(firstSpan.attributes, "checkpoint.run.id") ??
    firstSpan.spanContext().traceId;
  const agent =
    stringAttribute(firstSpan.attributes, "checkpoint.agent") ?? "unknown-agent";
  const source =
    stringAttribute(firstSpan.attributes, "checkpoint.source") ?? "production";

  if (source !== "ci" && source !== "production" && source !== "simulation") {
    throw new Error(`Unsupported checkpoint.source: ${source}`);
  }

  const steps: Step[] = stepSpans.map((span, index) => {
    const attributes = span.attributes;
    const type = stepTypeAttribute(attributes);

    if (!type) {
      throw new Error(`OpenTelemetry span ${span.name} is missing checkpoint.step.type.`);
    }

    const step: Step = {
      id:
        stringAttribute(attributes, "checkpoint.step.id") ??
        `span-step-${index + 1}`,
      type,
      name: stringAttribute(attributes, "checkpoint.step.name") ?? span.name,
      input: jsonAttribute(attributes, "checkpoint.step.input"),
      output: jsonAttribute(attributes, "checkpoint.step.output"),
      startedAt: hrTimeToIso(span.startTime),
      endedAt: spanEndIso(span)
    };

    const costUsd = numberAttribute(attributes, "checkpoint.cost_usd");
    const tokensIn = numberAttribute(attributes, "checkpoint.tokens_in");
    const tokensOut = numberAttribute(attributes, "checkpoint.tokens_out");
    const metadata = metadataFromAttributes(attributes);

    if (costUsd !== undefined) {
      step.costUsd = costUsd;
    }

    if (tokensIn !== undefined) {
      step.tokensIn = tokensIn;
    }

    if (tokensOut !== undefined) {
      step.tokensOut = tokensOut;
    }

    if (metadata) {
      step.metadata = metadata;
    }

    return step;
  });

  return {
    id: runId,
    agent,
    source,
    steps,
    startedAt: hrTimeToIso(firstSpan.startTime),
    endedAt: spanEndIso(lastSpan)
  };
}

export const openTelemetryTraceAdapter = {
  toRun: fromOpenTelemetrySpans
};
