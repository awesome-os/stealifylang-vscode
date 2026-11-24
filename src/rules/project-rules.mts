/**
 * @file .project-rules/project-rules.mts
 * @description Central Rule Engine, Registry & CLI for asserting project principles over any directory.
 * Node test runner compatible and runnable directly via:
 *   node .project-rules/project-rules.mts [target-directory]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type ProjectRule, type RuleViolation, type RuleResult } from './rule-types.mts';
import { ruleErasableSyntax } from './rule-erasable-syntax.mts';
import { rulePreferMtsExtension } from './rule-prefer-mts-extension.mts';
import { ruleEsmExplicitImports } from './rule-esm-explicit-imports.mts';
import { ruleNoShellScripts } from './rule-no-shell-scripts.mts';
import { ruleNoNpx } from './rule-no-npx.mts';
import { ruleCapabilityInjection } from './rule-capability-injection.mts';

export {
  type ProjectRule,
  type RuleViolation,
  type RuleResult,
  ruleErasableSyntax,
  rulePreferMtsExtension,
  ruleEsmExplicitImports,
  ruleNoShellScripts,
  ruleNoNpx,
  ruleCapabilityInjection,
};

export class ProjectRuleEngine {
  public rules: ProjectRule[];

  constructor(rules?: ProjectRule[]) {
    this.rules = rules || [
      ruleErasableSyntax,
      rulePreferMtsExtension,
      ruleEsmExplicitImports,
      ruleNoShellScripts,
      ruleNoNpx,
      ruleCapabilityInjection,
    ];
  }

  /**
   * Recursively scan directory and run rules across eligible files
   */
  public async scanDirectory(targetDir: string, options?: { ignore?: string[] }): Promise<{
    totalFiles: number;
    violations: RuleViolation[];
    passed: boolean;
  }> {
    const defaultIgnores = [
      'node_modules', '.git', 'dist', 'out', '.build',
      'vscode', 'patches', 'v8', 'build-tools'
    ];
    const ignores = options?.ignore ? [...defaultIgnores, ...options.ignore] : defaultIgnores;
    const filesToScan: string[] = [];

    const walk = (d: string) => {
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
          if (ignores.includes(entry.name)) continue;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            filesToScan.push(full);
          }
        }
      } catch {}
    };

    walk(targetDir);

    const violations: RuleViolation[] = [];
    for (const file of filesToScan) {
      let content = '';
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }

      for (const rule of this.rules) {
        const fileViolations = await rule.check(file, content);
        violations.push(...fileViolations);
      }
    }

    const errors = violations.filter(v => v.severity === 'error');
    return {
      totalFiles: filesToScan.length,
      violations,
      passed: errors.length === 0,
    };
  }

  /**
   * Run individual rule against content in memory
   */
  public async checkFile(filePath: string, content: string): Promise<RuleViolation[]> {
    const results: RuleViolation[] = [];
    for (const rule of this.rules) {
      const v = await rule.check(filePath, content);
      results.push(...v);
    }
    return results;
  }
}

// Direct CLI invocation
const isMain = process.argv[1] && (
  process.argv[1].endsWith('project-rules.mts') ||
  process.argv[1].endsWith('project-rules.mjs')
);

if (isMain) {
  const targetDir = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : process.cwd();
  console.log(`[ProjectRules] 🔍 Auditing directory: ${targetDir}`);

  const engine = new ProjectRuleEngine();
  engine.scanDirectory(targetDir).then((res) => {
    console.log(`[ProjectRules] Scanned ${res.totalFiles} files. Violations found: ${res.violations.length}`);
    for (const v of res.violations) {
      const loc = v.line ? `:${v.line}` : '';
      const prefix = v.severity === 'error' ? '❌ [ERROR]' : '⚠️ [WARN]';
      console.log(`  ${prefix} [${v.ruleId}] ${path.relative(targetDir, v.filePath)}${loc} - ${v.message}`);
      if (v.snippet) {
        console.log(`      Snippet: ${v.snippet}`);
      }
    }

    if (!res.passed) {
      console.error(`\n❌ Project rules enforcement FAILED with ${res.violations.filter(v => v.severity === 'error').length} error(s).`);
      process.exit(1);
    } else {
      console.log(`\n✔ Project rules enforcement PASSED.`);
    }
  }).catch((err) => {
    console.error('Fatal engine error:', err);
    process.exit(1);
  });
}
