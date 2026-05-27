import type { ActivityContext } from '../types.ts';
import type { Context } from './index.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import type { ErasedActivityDefinition, ErasedSagaStep } from './types.ts';

export function* saga<TFinalOutput = unknown>(
  context: Context,
  steps: ErasedSagaStep[],
): Generator<ContextOperationRequest, TFinalOutput, unknown> {
  const completed: Array<{
    definition: ErasedActivityDefinition;
    input: unknown;
    output: unknown;
  }> = [];

  let lastOutput: unknown;
  let compensationRun = false;

  context.onCancel(async () => {
    if (compensationRun) return;
    compensationRun = true;
    await compensateCompleted(completed);
  });

  for (const step of steps) {
    const stepDefinition = step.definition;
    try {
      const executeActivity = (input: unknown, activityContext?: ActivityContext) =>
        stepDefinition.execute(input, activityContext);

      Object.defineProperty(executeActivity, 'name', {
        value: stepDefinition.name,
        configurable: true,
      });

      const output = yield* context.run(executeActivity, step.input);
      completed.push({ definition: stepDefinition, input: step.input, output });
      lastOutput = output;
    } catch (stepError) {
      if (!compensationRun) {
        compensationRun = true;
        for (let index = completed.length - 1; index >= 0; index--) {
          const completedStep = completed[index]!;
          if (completedStep.definition.compensate !== undefined) {
            const capturedInput = completedStep.input;
            const capturedOutput = completedStep.output;
            const capturedDefinition = completedStep.definition;

            const compensateActivity = async () =>
              capturedDefinition.compensate?.(capturedInput, capturedOutput);

            Object.defineProperty(compensateActivity, 'name', {
              value: `compensate:${completedStep.definition.name}`,
              configurable: true,
            });

            try {
              yield* context.run(compensateActivity);
            } catch {
              // Compensator failures are intentionally swallowed so the original error propagates.
            }
          }
        }
      }

      throw stepError;
    }
  }

  return lastOutput as TFinalOutput;
}

async function compensateCompleted(
  completed: Array<{ definition: ErasedActivityDefinition; input: unknown; output: unknown }>,
): Promise<void> {
  for (let index = completed.length - 1; index >= 0; index--) {
    const completedStep = completed[index]!;
    if (completedStep.definition.compensate !== undefined) {
      try {
        await completedStep.definition.compensate(completedStep.input, completedStep.output);
      } catch {
        // Swallowed — cancellation still finalizes
      }
    }
  }
}
