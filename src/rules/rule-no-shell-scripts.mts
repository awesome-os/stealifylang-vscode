/**
 * @file .project-rules/rule-no-shell-scripts.mts
 * @description Rule prohibiting legacy `.sh` or `.bash` scripts in modernized component directories.
 * Shell scripts must be refactored into self-contained, statically analyzable `.mts` CLI modules.
 */

import { type ProjectRule, type RuleViolation } from './rule-types.mts';

export const ruleNoShellScripts: ProjectRule = {
  id: 'rule-no-shell-scripts',
  name: 'No Legacy Shell Scripts',
  description: 'Flags .sh/.bash files which should be refactored into cross-platform .mts CLI modules.',
  severity: 'error',
  check: (filePath: string, content: string): RuleViolation[] => {
    const violations: RuleViolation[] = [];

    if (filePath.endsWith('.sh') || filePath.endsWith('.bash')) {
      violations.push({
        ruleId: 'rule-no-shell-scripts',
        filePath,
        message: `Legacy shell script detected. Shell scripts must be refactored into cross-platform, static-analyzable .mts CLI modules.`,
        severity: 'error',
      });
    }

    return violations;
  },
};

export default ruleNoShellScripts;

