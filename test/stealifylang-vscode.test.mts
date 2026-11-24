import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  activate,
  auditProjectRules,
  deactivate,
  FAST_TYPESCRIPT_ARTIFACT,
  getDefaultRulesConfig,
  resolveFastTypeScriptPlan,
} from '../src/extension.mts'
import { auditSourceText } from '../src/lint/audit-rules.mts'
import { ProjectRuleEngine } from '../src/rules/project-rules.mts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

describe('stealifylang-vscode manifest & exports', () => {
  it('declares valid VS Code / Open VSX manifest, language, grammar, and commands', () => {
    const pkgPath = path.join(ROOT, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as any

    assert.equal(pkg.name, 'stealifylang-vscode')
    assert.equal(pkg.publisher, 'awesome-os')
    assert.equal(pkg.license, 'MIT')
    assert.equal(pkg.type, 'module')
    assert.equal(pkg.main, './src/extension.mts')

    const langs = pkg.contributes?.languages ?? []
    assert.ok(langs.some((l: any) => l.id === 'stealify' && l.extensions?.includes('.stealify')))
    assert.ok(fs.existsSync(path.join(ROOT, langs[0].configuration)))

    const grammars = pkg.contributes?.grammars ?? []
    assert.ok(grammars.some((g: any) => g.language === 'stealify' && g.scopeName === 'source.stealify'))
    assert.ok(fs.existsSync(path.join(ROOT, grammars[0].path)))

    const commandIds = (pkg.contributes?.commands ?? []).map((c: any) => c.command)
    for (const expected of [
      'stealifyLint.fixAll',
      'stealifyLint.auditWorkspace',
      'stealify.useFastTypeScript',
      'stealify.compileToB8e',
      'stealify.flushDiagnostics',
    ]) {
      assert.ok(commandIds.includes(expected), `Missing contributed command: ${expected}`)
    }
  })

  it('exports activate, deactivate, resolveFastTypeScriptPlan, and getDefaultRulesConfig', () => {
    assert.equal(typeof activate, 'function')
    assert.equal(typeof deactivate, 'function')
    assert.equal(typeof resolveFastTypeScriptPlan, 'function')
    assert.equal(typeof getDefaultRulesConfig, 'function')

    const defaults = getDefaultRulesConfig()
    assert.equal(defaults.ruleOverrides.B8G012, 'info')
    assert.equal(defaults.ruleOverrides.B8G013, 'info')
    assert.ok(defaults.projectRuleIds.includes('rule-erasable-syntax'))
    assert.ok(defaults.projectRuleIds.includes('rule-no-npx'))
    assert.ok(defaults.projectRuleIds.includes('rule-capability-injection'))
  })
})

describe('stealify-lint engine & --stdio LSP', () => {
  it('catches B8G016 local http.createServer IPC and B8G012/B8G013 ambient host coupling', () => {
    const sample = [
      "import http from 'node:http'",
      "const srv = http.createServer((_req, res) => res.end('ok'))",
      "srv.listen(8080, '127.0.0.1')",
      'export const pid = process.pid',
    ].join('\n')

    const diags = auditSourceText('/virtual/app/daemon.mts', sample)
    const codes = new Set(diags.map((d) => d.code))

    assert.ok(codes.has('B8G016'), `Expected B8G016 diagnostic, got: ${[...codes].join(', ')}`)
    assert.ok(codes.has('B8G013'), `Expected B8G013 diagnostic, got: ${[...codes].join(', ')}`)
    assert.ok(codes.has('B8G012'), `Expected B8G012 diagnostic, got: ${[...codes].join(', ')}`)
  })

  it('speaks JSON-RPC over --stdio and publishes live diagnostics', async () => {
    const cliPath = path.join(ROOT, 'src', 'lint', 'lint-cli.mts')
    const child = spawn(process.execPath, [cliPath, '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const messages: any[] = []
    let rx: Buffer = Buffer.alloc(0)

    const waitForMessage = (predicate: (msg: any) => boolean, timeoutMs = 5000): Promise<any> =>
      new Promise((resolve, reject) => {
        const existing = messages.find(predicate)
        if (existing) {
          resolve(existing)
          return
        }
        const timer = setTimeout(() => reject(new Error('Timed out waiting for LSP message')), timeoutMs)
        const onData = (chunk: Buffer) => {
          rx = Buffer.concat([rx, chunk])
          while (true) {
            const hdrEnd = rx.indexOf('\r\n\r\n')
            if (hdrEnd < 0) break
            const m = /Content-Length:\s*(\d+)/i.exec(rx.subarray(0, hdrEnd).toString('ascii'))
            if (!m) {
              rx = rx.subarray(hdrEnd + 4)
              continue
            }
            const len = Number(m[1])
            if (rx.length < hdrEnd + 4 + len) break
            const msg = JSON.parse(rx.subarray(hdrEnd + 4, hdrEnd + 4 + len).toString('utf8'))
            rx = rx.subarray(hdrEnd + 4 + len)
            messages.push(msg)
            if (predicate(msg)) {
              clearTimeout(timer)
              child.stdout?.off('data', onData)
              resolve(msg)
              return
            }
          }
        }
        child.stdout?.on('data', onData)
      })

    const send = (payload: Record<string, unknown>) => {
      const json = JSON.stringify(payload)
      child.stdin?.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`)
    }

    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: null, capabilities: {} } })
      const initRes = await waitForMessage((m) => m.id === 1)
      assert.equal(initRes.result?.serverInfo?.name, 'stealify-lint-lsp')

      const docUri = pathToFileURL(path.join(ROOT, 'virtual-ipc.mts')).toString()
      send({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: docUri,
            languageId: 'typescript',
            version: 1,
            text: "import http from 'node:http'\nhttp.createServer(() => {}).listen(3000, '127.0.0.1')\n",
          },
        },
      })

      const pub = await waitForMessage(
        (m) => m.method === 'textDocument/publishDiagnostics' && m.params?.uri === docUri
      )
      const codes = new Set((pub.params?.diagnostics ?? []).map((d: any) => d.code))
      assert.ok(codes.has('B8G016'), `Expected LSP B8G016 diagnostic, got: ${[...codes].join(', ')}`)

      send({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null })
      await waitForMessage((m) => m.id === 2)
      send({ jsonrpc: '2.0', method: 'exit', params: null })
    } finally {
      child.kill()
    }
  })
})

describe('governance project-rules engine', () => {
  it('catches npx usage, non-erasable enum syntax, and extension-less ESM imports', async () => {
    const engine = new ProjectRuleEngine()
    const badSource = [
      "import { helper } from './helper'",
      'export enum BadMode { Fast, Slow }',
      'const cmd = "npx tsx index.ts"',
    ].join('\n')

    const violations = await engine.checkFile('/virtual/src/sample.mts', badSource)
    const ruleIds = new Set(violations.map((v) => v.ruleId))

    assert.ok(ruleIds.has('rule-no-npx'), 'Expected rule-no-npx violation')
    assert.ok(ruleIds.has('rule-erasable-syntax'), 'Expected rule-erasable-syntax violation')
    assert.ok(ruleIds.has('rule-esm-explicit-imports'), 'Expected rule-esm-explicit-imports violation')
  })

  it('audits a clean portable workspace with auditProjectRules (zero violations)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stealifylang-vscode-rules-'))
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'portable.mts'),
        [
          'export type Mode = "fast" | "safe"',
          'export function greet(name: string, mode: Mode): string {',
          '  return `${mode}:${name}`',
          '}',
        ].join('\n'),
        'utf8'
      )
      const res = await auditProjectRules(tmpDir)
      assert.equal(res.totalFiles, 1)
      assert.equal(res.passed, true)
      assert.deepEqual(res.violations, [])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Wave-2 TypeScript 6.0.3 live cas-v1 resolver', () => {
  it('resolves typescript-6.0.3-programmable.tar.gz from awesome-os/b8g-ghost manifests/index.json', async () => {
    const plan = await resolveFastTypeScriptPlan()
    assert.equal(plan.artifact, FAST_TYPESCRIPT_ARTIFACT)
    assert.equal(plan.version, '6.0.3-wave2')
    assert.match(plan.sha256, /^[0-9a-f]{64}$/)
    assert.ok(plan.bytes > 1_000_000, `Expected >1MB archive, got ${plan.bytes}`)
    assert.ok(plan.downloadUrl.includes('/releases/download/cas-v1/'))
    assert.equal(plan.tsdkSettingKey, 'typescript.tsdk')
  })
})
