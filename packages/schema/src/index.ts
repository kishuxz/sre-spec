import { z } from "zod";

export type AssertionSeverity = "blocking" | "advisory";

export interface SequenceRule {
  step: string;
  after: string[];
  message?: string;
}

export interface Assertion<TRun = unknown> {
  id: string;
  severity?: AssertionSeverity;
  message?: string;
  check: (run: TRun) => boolean;
  judge?: {
    prompt: string;
    model: string;
  };
}

export interface Spec<TRun = unknown> {
  id: string;
  version: string;
  agent: string;
  tools?: {
    allowed?: string[];
    forbidden?: string[];
  };
  sequence?: SequenceRule[];
  preconditions?: Assertion<TRun>[];
  postconditions?: Assertion<TRun>[];
  budget?: {
    maxToolCalls?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    maxDurationMs?: number;
    maxResourcesTouched?: number;
  };
  assertions?: Assertion<TRun>[];
}

export interface SerializableAssertion {
  id: string;
  severity: AssertionSeverity;
  message?: string;
  deterministic: boolean;
  judge?: {
    prompt: string;
    model: string;
  };
}

export interface SerializableSpec {
  id: string;
  version: string;
  agent: string;
  tools?: {
    allowed?: string[];
    forbidden?: string[];
  };
  sequence?: SequenceRule[];
  preconditions?: SerializableAssertion[];
  postconditions?: SerializableAssertion[];
  budget?: Spec["budget"];
  assertions?: SerializableAssertion[];
}

const judgeSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().min(1)
});

const assertionSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["blocking", "advisory"]).optional(),
  message: z.string().min(1).optional(),
  check: z.function(),
  judge: judgeSchema.optional()
});

export const sequenceRuleSchema = z.object({
  step: z.string().min(1),
  after: z.array(z.string().min(1)).min(1),
  message: z.string().min(1).optional()
});

export const specSchema = z.object({
  id: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, {
    message: "version must be semver-like, for example 1.0.0"
  }),
  agent: z.string().min(1),
  tools: z
    .object({
      allowed: z.array(z.string().min(1)).optional(),
      forbidden: z.array(z.string().min(1)).optional()
    })
    .optional(),
  sequence: z.array(sequenceRuleSchema).optional(),
  preconditions: z.array(assertionSchema).optional(),
  postconditions: z.array(assertionSchema).optional(),
  budget: z
    .object({
      maxToolCalls: z.number().int().nonnegative().optional(),
      maxTokens: z.number().int().nonnegative().optional(),
      maxCostUsd: z.number().nonnegative().optional(),
      maxDurationMs: z.number().int().nonnegative().optional(),
      maxResourcesTouched: z.number().int().nonnegative().optional()
    })
    .optional(),
  assertions: z.array(assertionSchema).optional()
});

export const serializableAssertionSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["blocking", "advisory"]),
  message: z.string().min(1).optional(),
  deterministic: z.boolean(),
  judge: judgeSchema.optional()
});

export const serializableSpecSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  agent: z.string().min(1),
  tools: specSchema.shape.tools,
  sequence: z.array(sequenceRuleSchema).optional(),
  preconditions: z.array(serializableAssertionSchema).optional(),
  postconditions: z.array(serializableAssertionSchema).optional(),
  budget: specSchema.shape.budget,
  assertions: z.array(serializableAssertionSchema).optional()
});

export function defineSpec<TRun = unknown>(spec: Spec<TRun>): Spec<TRun> {
  const parsed = specSchema.safeParse(spec);

  if (!parsed.success) {
    const details = z.prettifyError(parsed.error);
    throw new Error(`Invalid Checkpoint spec:\n${details}`);
  }

  return spec;
}

function serializeAssertion<TRun>(
  assertion: Assertion<TRun>
): SerializableAssertion {
  return {
    id: assertion.id,
    severity: assertion.severity ?? "blocking",
    ...(assertion.message ? { message: assertion.message } : {}),
    deterministic: typeof assertion.check === "function",
    ...(assertion.judge ? { judge: assertion.judge } : {})
  };
}

export function toSerializableSpec<TRun>(
  spec: Spec<TRun>
): SerializableSpec {
  const validated = defineSpec(spec);
  const serializable: SerializableSpec = {
    id: validated.id,
    version: validated.version,
    agent: validated.agent
  };

  if (validated.tools) {
    serializable.tools = validated.tools;
  }

  if (validated.sequence) {
    serializable.sequence = validated.sequence;
  }

  if (validated.preconditions) {
    serializable.preconditions = validated.preconditions.map(
      serializeAssertion
    );
  }

  if (validated.postconditions) {
    serializable.postconditions = validated.postconditions.map(
      serializeAssertion
    );
  }

  if (validated.budget) {
    serializable.budget = validated.budget;
  }

  if (validated.assertions) {
    serializable.assertions = validated.assertions.map(serializeAssertion);
  }

  return serializable;
}
