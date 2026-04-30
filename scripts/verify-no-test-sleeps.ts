/**
 * Fails when test files call Bun.sleep directly.
 *
 * Tests should use src/testing/fake-timers.ts helpers so time is controlled by
 * Bun fake timers instead of wall-clock sleeps.
 */

const testFileGlobs = [
  new Bun.Glob('src/**/*.{test,spec}.ts'),
  new Bun.Glob('scripts/**/*.{test,spec}.ts'),
];
const forbiddenCallPattern = /\bBun\.sleep\s*\(/g;

let failures = 0;

for (const testFileGlob of testFileGlobs) {
  for await (const filePath of testFileGlob.scan({ absolute: false, onlyFiles: true })) {
    const text = await Bun.file(filePath).text();
    const lines = text.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      forbiddenCallPattern.lastIndex = 0;

      if (!forbiddenCallPattern.test(line)) continue;

      failures++;
      console.error(`${filePath}:${lineIndex + 1}: direct Bun.sleep call in test file`);
    }
  }
}

if (failures > 0) {
  console.error(
    `\nFound ${failures} direct Bun.sleep call(s). Use src/testing/fake-timers.ts helpers instead.`,
  );
  process.exit(1);
}

console.log('No direct Bun.sleep calls found in test files.');
