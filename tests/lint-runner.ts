import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runs a lint tool that exits non-zero when it reports an error — which is the case under test —
 * and returns its JSON report from stdout either way.
 */
export function runForJson(bin: string, args: string[], cwd: string): unknown {
  let stdout: string;
  try {
    stdout = execFileSync(path.join(ROOT, 'node_modules/.bin', bin), args, {
      cwd,
      encoding: 'utf8',
    });
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? '';
    if (!stdout) throw error;
  }
  return JSON.parse(stdout);
}

export interface LintMessage {
  ruleId: string | null;
  message: string;
  line: number;
}

export function eslint(file: string): LintMessage[] {
  const report = runForJson('eslint', ['--no-ignore', '--format', 'json', file], ROOT) as Array<{
    messages: LintMessage[];
  }>;
  return report.flatMap((r) => r.messages);
}
