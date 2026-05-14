import { describe, expect, it } from 'bun:test';

const negotiatedOperationFiles = [
  'src/server/operations/list-checkpoints.ts',
  'src/server/operations/get-checkpoint-at.ts',
  'src/server/operations/get-workflow-timeline.ts',
  'src/server/operations/replay-workflow.ts',
] as const;

describe('REST MessagePack negotiation ownership', () => {
  it('keeps success negotiation in the shared response helper', async () => {
    for (const filePath of negotiatedOperationFiles) {
      const source = await Bun.file(filePath).text();

      expect(source).toContain(
        "import { negotiatedResponse } from '../handler/response-helpers.ts'",
      );
      expect(source).not.toContain("import { encode } from '../../core/codec.ts'");
      expect(source).not.toContain("headers: { 'Content-Type': 'application/msgpack' }");
    }
  });
});
