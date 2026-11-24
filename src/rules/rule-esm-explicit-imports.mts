/**
 * @file .project-rules/rule-esm-explicit-imports.mts
 * @description Rule requiring all relative imports/exports to specify full extensions (e.g. `.mts` or `.js`).
 * Prohibits extension-less relative imports (e.g. `import foo from './foo'`) which fail in native ESM.
 */

import { type ProjectRule, type RuleViolation } from './rule-types.mts';

export const ruleEsmExplicitImports: ProjectRule = {
  id: 'rule-esm-explicit-imports',
  name: 'Enforce Explicit File Extensions in ESM Imports',
  description: 'Requires all relative import and export statements to specify their file extension.',
  severity: 'error',
  check: (filePath: string, content: string): RuleViolation[] => {
    const violations: RuleViolation[] = [];
    if (!filePath.endsWith('.mts') && !filePath.endsWith('.ts')) {
      return violations;
    }

    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      const lineNum = index + 1;
      const trimmed = line.trim();

      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return;

      // Match: from './...' or from '../...' or import './...'
      const importMatch = trimmed.match(/(?:from|import)\s+['"](\.{1,2}\/[^'"]+)['"]/);
      if (importMatch && importMatch[1]) {
        const importSpecifier = importMatch[1];
        // Check if ends with a recognized extension
        const hasExt = /\.[a-zA-Z0-9]+$/.test(importSpecifier);
        if (!hasExt) {
          violations.push({
            ruleId: 'rule-esm-explicit-imports',
            filePath,
            line: lineNum,
            message: `Relative import "${importSpecifier}" lacks an explicit file extension. Use ".mts" or ".js".`,
            severity: 'error',
            snippet: line.trim(),
          });
        }
      }
    });

    return violations;
  },
};

export default ruleEsmExplicitImports;

