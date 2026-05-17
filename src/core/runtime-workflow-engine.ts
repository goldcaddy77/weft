import type { Engine } from './engine.ts';
import type { ActivityFunction, WorkflowRegistryEntry } from './types.ts';

type RuntimeWorkflowRegistry = Record<string, WorkflowRegistryEntry>;
type RuntimeActivityTypes = Record<string, ActivityFunction>;

export type RuntimeWorkflowEngine = Engine<RuntimeWorkflowRegistry, RuntimeActivityTypes>;

export function runtimeWorkflowEngine(engine: unknown): RuntimeWorkflowEngine {
  // Transport adapters receive workflow names from validated runtime payloads.
  // The runtime Engine still enforces registration; this helper is the one
  // type escape hatch from compile-time registries to that dynamic surface.
  return engine as RuntimeWorkflowEngine;
}
