/**
 * @file .project-rules/rule-types.mts
 * @description Core types and interfaces for the project rule enforcement engine.
 * Compatible with Node test runner (node:test) and strict erasable TypeScript syntax.
 */

export type RuleSeverity = 'error' | 'warning' | 'info';

export type RuleViolation = {
  ruleId: string;
  filePath: string;
  line?: number;
  column?: number;
  message: string;
  severity: RuleSeverity;
  snippet?: string;
};

export type RuleResult = {
  ruleId: string;
  passed: boolean;
  violations: RuleViolation[];
};

export type ProjectRule = {
  id: string;
  name: string;
  description: string;
  severity: RuleSeverity;
  check: (targetPath: string, fileContent: string) => Promise<RuleViolation[]> | RuleViolation[];
};

