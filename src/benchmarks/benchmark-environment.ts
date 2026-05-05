export function isConstrainedCodexRunner(): boolean {
  return process.env['CODEX_CI'] === '1' || process.env['GITHUB_ACTIONS'] === 'true';
}
