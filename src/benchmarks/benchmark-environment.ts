export function isConstrainedCodexRunner(): boolean {
  return process.env['CODEX_CI'] === '1';
}
