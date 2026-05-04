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

  for (const step of steps) {
    const stepDefinition = step.definition;
    try {
      const capturedInput = step.input;
      const executeActivity = (...injected: unknown[]) =>
        stepDefinition.execute(capturedInput, injected[0] as ActivityContext | undefined);

      Object.defineProperty(executeActivity, 'name', {
        value: stepDefinition.name,
        configurable: true,
      });

      const output = yield* context.run(executeActivity);
      completed.push({ definition: stepDefinition, input: step.input, output });
      lastOutput = output;
    } catch (stepError) {
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

      throw stepError;
    }
  }

  return lastOutput as TFinalOutput;
}
