/**
 * Transport-neutral operation catalog and the single dispatch pipeline.
 *
 * `executeOperation` is the only function transport adapters call to invoke an
 * operation. REST, JSON-RPC HTTP, JSON-RPC WebSocket, and stdio all share one
 * access check, one input validation step, one authorization hook, and one
 * error classifier.
 *
 * @module server/operation-catalog
 */

export { classifyEngineError } from './pipeline-helpers.ts';
export { executeOperation } from './pipeline.ts';
export { createOperationRegistry } from './registry.ts';
export {
  OPERATION_NAME_PATTERN,
  isValidOperationName,
  validateOperationName,
  type AuthorizationDecision,
  type DispatchContext,
  type DispatchResult,
  type ErasedOperation,
  type OperationContext,
  type OperationDefinition,
  type OperationRegistry,
  type RegistrableOperation,
  type TransportAvailability,
  type UnknownKeyDisposition,
  type UnknownKeyPolicy,
} from './types.ts';
