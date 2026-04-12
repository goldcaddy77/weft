const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function assertValidWorkflowId(id: string, fieldName: string = 'options.id'): void {
  if (id.length === 0) {
    throw new Error(`${fieldName} must not be an empty string`);
  }

  if (!WORKFLOW_ID_PATTERN.test(id)) {
    throw new Error(
      `${fieldName} must contain only letters, numbers, dots, underscores, and hyphens, and be at most 128 characters`,
    );
  }
}
