/**
 * @file src/rules/rule-capability-injection.mts
 * @description Hard error rule enforcing Zero Ambient Authority & Capability Injection (`*Like`)
 * across portable `.mts`/`.ts` modules (matching stealify-lint `B8G012` & `B8G013`).
 */

import { type ProjectRule, type RuleViolation } from './rule-types.mts';
import { scanHostCoupling } from '../lint/capability-iife-refactor.mts';

function isHostAdapterOrTestPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return (
    base.endsWith('.host.mts') ||
    base.endsWith('.host.ts') ||
    base.endsWith('.test.mts') ||
    base.endsWith('.test.ts') ||
    base === 'maintenance.mts' ||
    norm.includes('/e2e/') ||
    norm.includes('/.project-rules/') ||
    norm.startsWith('.project-rules/') ||
    norm.includes('/projections/') ||
    norm.includes('/packages/@awesome-os/bin-shim/')
  );
}

export const ruleCapabilityInjection: ProjectRule = {
  id: 'rule-capability-injection',
  name: 'Enforce Capability Injection (Zero Ambient Authority)',
  description:
    'Prohibits direct `node:*` imports (`B8G013`) and ambient `process`/`Buffer`/`__dirname`/`__filename` (`B8G012`) outside `.host.mts`, `maintenance.mts`, and test files.',
  severity: 'error',
  check: (filePath: string, content: string): RuleViolation[] => {
    const violations: RuleViolation[] = [];
    if (!filePath.endsWith('.mts') && !filePath.endsWith('.ts')) {
      return violations;
    }
    if (filePath.endsWith('.d.ts') || filePath.endsWith('.d.mts') || isHostAdapterOrTestPath(filePath)) {
      return violations;
    }

    const coupling = scanHostCoupling(content);
    for (const g of coupling.globals) {
      violations.push({
        ruleId: 'rule-capability-injection',
        filePath,
        line: g.line + 1,
        column: g.character + 1,
        message: `[B8G012] Ambient host global '${g.name}' is forbidden in portable modules. Inject '${g.capType}' via '(caps) => ...'.`,
        severity: 'error',
        snippet: g.name,
      });
    }

    for (const imp of coupling.imports) {
      violations.push({
        ruleId: 'rule-capability-injection',
        filePath,
        line: imp.line + 1,
        column: imp.character + 1,
        message: `[B8G013] Direct host import '${imp.spec}' is forbidden in portable modules. Inject '${imp.capType}' via '(caps: { ${imp.capKey}: ${imp.capType} }) => ...'.`,
        severity: 'error',
        snippet: imp.statementText,
      });
    }

    for (const req of coupling.requires) {
      violations.push({
        ruleId: 'rule-capability-injection',
        filePath,
        line: req.line + 1,
        column: req.character + 1,
        message: `[B8G013] Direct host require '${req.spec}' is forbidden in portable modules. Inject '${req.capType}' via '(caps) => ...'.`,
        severity: 'error',
        snippet: req.spec,
      });
    }

    return violations;
  },
};

export default ruleCapabilityInjection;
