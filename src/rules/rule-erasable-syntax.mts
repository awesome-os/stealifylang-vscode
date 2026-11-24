/**
 * @file .project-rules/rule-erasable-syntax.mts
 * @description Rule enforcing Erasable TypeScript syntax (Node 26+ native type-stripping).
 * 
 * Enforces:
 * 1. No TypeScript Parameter Properties in class constructors (e.g. `constructor(public x: string)`).
 * 2. No runtime enums (e.g. `enum Foo { A, B }`) - prefer union string types or `const Foo = { ... } as const`.
 * 3. No namespace declarations (`namespace Foo { ... }`).
 */

import { type ProjectRule, type RuleViolation } from './rule-types.mts';

export const ruleErasableSyntax: ProjectRule = {
  id: 'rule-erasable-syntax',
  name: 'Enforce Erasable TypeScript Syntax',
  description: 'Prohibits non-erasable TypeScript features: parameter properties, enums, and namespaces.',
  severity: 'error',
  check: (filePath: string, content: string): RuleViolation[] => {
    const violations: RuleViolation[] = [];
    if (!filePath.endsWith('.ts') && !filePath.endsWith('.mts')) {
      return violations;
    }

    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      const lineNum = index + 1;
      const trimmed = line.trim();

      // Skip comment lines
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        return;
      }

      // 1. Detect parameter properties: constructor(... public | private | protected | readonly ...)
      const paramPropRegex = /constructor\s*\([^)]*\b(public|private|protected|readonly)\s+[^)]+\)/;
      if (paramPropRegex.test(line)) {
        violations.push({
          ruleId: 'rule-erasable-syntax',
          filePath,
          line: lineNum,
          message: 'Constructor parameter properties are prohibited in erasable TypeScript. Declare class fields explicitly.',
          severity: 'error',
          snippet: line.trim(),
        });
      }

      // 2. Detect standard non-const enum
      const enumRegex = /^export\s+(const\s+)?enum\s+[A-Za-z0-9_]+|^\s*enum\s+[A-Za-z0-9_]+/;
      if (enumRegex.test(trimmed)) {
        violations.push({
          ruleId: 'rule-erasable-syntax',
          filePath,
          line: lineNum,
          message: 'TypeScript enums are runtime constructs not fully erasable by type-stripping. Use union string types or `as const` objects instead.',
          severity: 'error',
          snippet: line.trim(),
        });
      }

      // 3. Detect namespace blocks
      const namespaceRegex = /^export\s+namespace\s+[A-Za-z0-9_]+|^\s*namespace\s+[A-Za-z0-9_]+/;
      if (namespaceRegex.test(trimmed)) {
        violations.push({
          ruleId: 'rule-erasable-syntax',
          filePath,
          line: lineNum,
          message: 'Namespaces are non-erasable. Use standard ECMAScript modules (export/import).',
          severity: 'error',
          snippet: line.trim(),
        });
      }
    });

    return violations;
  },
};

export default ruleErasableSyntax;

