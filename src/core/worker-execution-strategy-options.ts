export interface WorkerExecutionStrategyOptions {
  broadcastEvents?: boolean;
  workflowTurnTimeoutMs?: number;
  maxProtocolMessageBytes?: number;
  requireProtocolVersion?: boolean;
  discardOnCancel?: boolean;
}
