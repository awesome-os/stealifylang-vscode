/**
 * @file .project-rules/rule-prefer-mts-extension.mts
 * @description Rule requiring modern TypeScript files to use explicit `.mts` extension
 * instead of legacy `.ts` / CommonJS `.cts`, ensuring clean native ESM module resolution.
 */

import { type ProjectRule, type RuleViolation } from './rule-types.mts';

export const rulePreferMtsExtension: ProjectRule = {
  id: 'rule-prefer-mts-extension',
  name: 'Prefer Explicit .mts Extensions',
  description: 'Flags .ts files that should be refactored to modern explicit .mts ESM extensions.',
  severity: 'warning',
  check: (filePath: string, content: string): RuleViolation[] => {
    const violations: RuleViolation[] = [];

    // Ignore declaration files (.d.ts) or non-TS files
    if (filePath.endsWith('.d.ts') || !filePath.endsWith('.ts')) {
      return violations;
    }

    // If it's a plain .ts file, recommend refactoring to .mts
    violations.push({
      ruleId: 'rule-prefer-mts-extension',
      filePath,
      message: `File uses legacy '.ts' extension. Refactor to '.mts' for explicit ESM and Node native type-stripping support.`,
      severity: 'warning',
    });

    return violations;
  },
};

export default rulePreferMtsExtension;

