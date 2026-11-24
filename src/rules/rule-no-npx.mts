/**
 * @file .project-rules/rule-no-npx.mts
 * @description Rule prohibiting `npx` invocations in codebase files or shell commands.
 * Per project constraints, `pnx` must always be used instead.
 */

import { type ProjectRule, type RuleViolation } from './rule-types.mts';

export const ruleNoNpx: ProjectRule = {
  id: 'rule-no-npx',
  name: 'No npx Execution',
  description: 'Prohibits "npx" in scripts and code; requires "pnx" runner.',
  severity: 'error',
  check: (filePath: string, content: string): RuleViolation[] => {
    const violations: RuleViolation[] = [];

    // Skip node_modules or binary files
    if (filePath.includes('node_modules') || filePath.includes('.git')) {
      return violations;
    }

    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      const lineNum = index + 1;
      const trimmed = line.trim();

      if (trimmed.startsWith('//') || trimmed.startsWith('/*')) return;

      // Detect standalone npx command usage (e.g. `npx `, `"npx `, `'npx `)
      if (/\b(?<!p)npx\s+[a-zA-Z0-9@\-_]/.test(line)) {
        violations.push({
          ruleId: 'rule-no-npx',
          filePath,
          line: lineNum,
          message: `Forbidden 'npx' execution found. Always use 'pnx' instead.`,
          severity: 'error',
          snippet: line.trim(),
        });
      }
    });

    return violations;
  },
};

export default ruleNoNpx;

