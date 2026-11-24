#!/usr/bin/env node
/**
 * @module
 * stealify-lint — Dual-Mode CLI & Zero-Dependency `--stdio` LSP Server.
 *
 * Scans TS/JS/Python codebases for runtime & kernel boundary anti-patterns
 * (`B8G001`–`B8G011`) or speaks standard LSP JSON-RPC over stdin/stdout with
 * live diagnostics + one-click QuickFixes.
 *
 * Usage:
 *   node packages/@awesome-os/stealifylang-cli/lint-cli.mts [dirs...] [--json] [--fix] [--fail-on-error]
 *   node packages/@awesome-os/stealifylang-cli/lint-cli.mts --stdio
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  auditSourceText,
  clearStealifyRulesCache,
  findStealifyRuleFiles,
  getStealifyRulesForFile,
  isHostBoundaryFile,
  loadStealifyRulesFromPath,
  scanAndAuditPathsAsync,
  type AuditDiagnostic,
  type CustomStealifyRule,
} from './audit-rules.mts'
import {
  auditSourceTextWithCas,
  BlockCasStore,
  defaultCasStore,
  type CasMetrics,
} from './b8g-block-cas.mts'
import {
  emitCapabilityHostAdapter,
  refactorToCapabilityIife,
} from './capability-iife-refactor.mts'

function uriToFsPath(uri: string): string {
  try {
    if (uri.startsWith('file://')) return fileURLToPath(uri)
  } catch {}
  return uri
}

function formatTextReport(
  diags: readonly AuditDiagnostic[],
  filesScanned: number,
  filesSkipped: number,
  durationMs: number,
  casMetrics?: CasMetrics
): string {
  const lines: string[] = []
  for (const d of diags) {
    const tag = d.severity === 1 ? 'ERROR' : d.severity === 2 ? 'WARN ' : 'INFO '
    lines.push(
      `${d.filePath}:${d.range.start.line + 1}:${d.range.start.character + 1} [${tag} ${d.code}] ${d.message}`
    )
  }
  const errCount = diags.filter((d) => d.severity === 1).length
  const warnCount = diags.filter((d) => d.severity === 2).length
  lines.push(
    `\nstealify-lint: scanned ${filesScanned} file(s) (${filesSkipped} skipped: .d.ts/.min/>512KB) in ${durationMs} ms — ${errCount} error(s), ${warnCount} warning(s), ${diags.length - errCount - warnCount} info.`
  )
  if (casMetrics && casMetrics.totalBlocks > 0) {
    lines.push(
      `  ⚡ Sub-Module CAS: ${casMetrics.totalBlocks} declaration blocks (${casMetrics.cacheHits} hits, ${casMetrics.hitRatePercent}% hit rate, ~${casMetrics.evalTimeSavedMs}ms CPU saved)`
    )
  }
  return lines.join('\n')
}

export function startLspServer(): void {
  const docs = new Map<string, { text: string; diagnostics: AuditDiagnostic[] }>()
  const lspCasStore = new BlockCasStore()
  let rxBuf: Buffer = Buffer.alloc(0)
  let shutdownRequested = false

  const writeMessage = (payload: Record<string, unknown>) => {
    const json = JSON.stringify(payload)
    const byteLen = Buffer.byteLength(json, 'utf8')
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`)
  }

  const publishForDoc = (uri: string, text: string) => {
    const filePath = uriToFsPath(uri)
    const { diagnostics } = auditSourceTextWithCas(filePath, text, lspCasStore)
    docs.set(uri, { text, diagnostics })
    writeMessage({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        diagnostics: diagnostics.map((d) => ({
          range: d.range,
          severity: d.severity,
          code: d.code,
          source: 'stealify-lint',
          message: d.message,
        })),
      },
    })
  }

  const offsetToPos = (text: string, offset: number) => {
    let line = 0
    let character = 0
    for (let i = 0; i < offset && i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        line++
        character = 0
      } else {
        character++
      }
    }
    return { line, character }
  }

  const rangesOverlap = (
    a: AuditDiagnostic['range'],
    b: { start: { line: number; character: number }; end: { line: number; character: number } }
  ) => {
    if (a.end.line < b.start.line || b.end.line < a.start.line) return false
    if (a.end.line === b.start.line && a.end.character < b.start.character) return false
    if (b.end.line === a.start.line && b.end.character < a.start.character) return false
    return true
  }

  const handleMessage = (msg: any) => {
    if (msg.method === 'initialize') {
      writeMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          serverInfo: { name: 'stealify-lint-lsp', version: '1.0.0' },
          capabilities: {
            textDocumentSync: 1, // Full document sync
            codeActionProvider: true,
          },
        },
      })
      return
    }

    if (msg.method === 'shutdown') {
      shutdownRequested = true
      writeMessage({ jsonrpc: '2.0', id: msg.id, result: null })
      return
    }

    if (msg.method === 'exit') {
      process.exit(shutdownRequested ? 0 : 1)
      return
    }

    if (msg.method === 'textDocument/didOpen' && msg.params?.textDocument) {
      const td = msg.params.textDocument
      publishForDoc(td.uri, td.text)
      return
    }

    if (msg.method === 'textDocument/didChange' && msg.params?.textDocument) {
      const uri = msg.params.textDocument.uri as string
      const changes = msg.params.contentChanges as Array<{ text: string }>
      if (changes && changes.length > 0) {
        publishForDoc(uri, changes[changes.length - 1].text)
      }
      return
    }

    if (msg.method === 'textDocument/didClose' && msg.params?.textDocument) {
      const uri = msg.params.textDocument.uri as string
      docs.delete(uri)
      writeMessage({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri, diagnostics: [] },
      })
      return
    }

    if (msg.method === 'textDocument/didSave' && msg.params?.textDocument) {
      const uri = msg.params.textDocument.uri as string
      const filePath = uriToFsPath(uri)
      if (filePath.includes('.stealify-rules')) {
        clearStealifyRulesCache()
        lspCasStore.clear()
        for (const [u, doc] of docs.entries()) {
          publishForDoc(u, doc.text)
        }
      }
      return
    }

    if (msg.method === 'workspace/didChangeWatchedFiles' || msg.method === 'stealify/reloadRules') {
      clearStealifyRulesCache()
      lspCasStore.clear()
      for (const [uri, doc] of docs.entries()) {
        publishForDoc(uri, doc.text)
      }
      return
    }

    if (msg.method === 'textDocument/codeAction' && msg.id !== undefined) {
      const uri = msg.params?.textDocument?.uri as string
      const reqRange = msg.params?.range
      const onlyKinds = Array.isArray(msg.params?.context?.only)
        ? (msg.params.context.only as string[])
        : null
      const wantQuickFix = !onlyKinds || onlyKinds.some((k) => k === 'quickfix' || k.startsWith('quickfix.'))
      const wantFixAll = onlyKinds !== null && onlyKinds.some((k) => k === 'source.fixAll' || k === 'source')

      const entry = docs.get(uri)
      const actions: any[] = []
      if (entry) {
        if (wantQuickFix && reqRange) {
          for (const d of entry.diagnostics) {
            if (!d.fix || !rangesOverlap(d.range, reqRange)) continue
            actions.push({
              title: `${d.code}: ${d.fix.title}`,
              kind: 'quickfix',
              diagnostics: [
                {
                  range: d.range,
                  severity: d.severity,
                  code: d.code,
                  source: 'stealify-lint',
                  message: d.message,
                },
              ],
              edit: {
                changes: {
                  [uri]: [
                    {
                      range: {
                        start: offsetToPos(entry.text, d.fix.startOffset),
                        end: offsetToPos(entry.text, d.fix.endOffset),
                      },
                      newText: d.fix.replacement,
                    },
                  ],
                },
              },
            })
          }
        }

        if (wantFixAll) {
          const fixable = entry.diagnostics
            .filter((d) => d.fix !== undefined)
            .sort((a, b) => a.fix!.startOffset - b.fix!.startOffset)
          const nonOverlapping: Array<{ range: { start: any; end: any }; newText: string }> = []
          let cursor = 0
          for (const d of fixable) {
            const f = d.fix!
            if (f.startOffset < cursor) continue
            nonOverlapping.push({
              range: {
                start: offsetToPos(entry.text, f.startOffset),
                end: offsetToPos(entry.text, f.endOffset),
              },
              newText: f.replacement,
            })
            cursor = f.endOffset
          }
          if (nonOverlapping.length > 0) {
            actions.push({
              title: `stealify-lint: Fix all ${nonOverlapping.length} auto-fixable B8G issues`,
              kind: 'source.fixAll',
              edit: { changes: { [uri]: nonOverlapping } },
            })
          }
        }

        const wantRefactor =
          !onlyKinds ||
          onlyKinds.some(
            (k) => k === 'quickfix' || k.startsWith('quickfix.') || k === 'refactor' || k.startsWith('refactor.')
          )
        const hasCapDiags = entry.diagnostics.some((d) => d.code === 'B8G012' || d.code === 'B8G013')
        if (wantRefactor && (hasCapDiags || onlyKinds?.some((k) => k === 'refactor' || k.startsWith('refactor.')))) {
          const filePath = uriToFsPath(uri)
          const ref = refactorToCapabilityIife(entry.text, { filePath })
          if (ref.changed) {
            actions.push({
              title: `B8G012/B8G013: Wrap module in Rollup-IIFE capability factory (${ref.factoryName})`,
              kind: hasCapDiags ? 'quickfix' : 'refactor.rewrite',
              edit: {
                changes: {
                  [uri]: [
                    {
                      range: {
                        start: { line: 0, character: 0 },
                        end: offsetToPos(entry.text, entry.text.length),
                      },
                      newText: ref.code,
                    },
                  ],
                },
              },
            })
          }
        }
      }
      writeMessage({ jsonrpc: '2.0', id: msg.id, result: actions })
      return
    }

    if (msg.id !== undefined) {
      writeMessage({ jsonrpc: '2.0', id: msg.id, result: null })
    }
  }

  process.stdin.on('data', (chunk: Buffer) => {
    rxBuf = rxBuf.length > 0 ? Buffer.concat([rxBuf, chunk]) : chunk
    while (true) {
      const hdrEnd = rxBuf.indexOf('\r\n\r\n')
      if (hdrEnd < 0) break
      const hdr = rxBuf.subarray(0, hdrEnd).toString('ascii')
      const m = /Content-Length:\s*(\d+)/i.exec(hdr)
      if (!m) {
        rxBuf = rxBuf.subarray(hdrEnd + 4)
        continue
      }
      const len = Number(m[1])
      const bodyStart = hdrEnd + 4
      if (rxBuf.length < bodyStart + len) break
      const jsonText = rxBuf.subarray(bodyStart, bodyStart + len).toString('utf8')
      rxBuf = rxBuf.subarray(bodyStart + len)
      try {
        handleMessage(JSON.parse(jsonText))
      } catch {}
    }
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--stdio')) {
    startLspServer()
    return
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'stealify-lint — Runtime & Kernel Boundary Pattern Analyzer + `--stdio` LSP',
        '',
        'Usage:',
        '  node packages/@awesome-os/stealifylang-cli/lint-cli.mts [paths...] [--json] [--sarif] [--fix] [--fail-on-error]',
        '  node packages/@awesome-os/stealifylang-cli/lint-cli.mts [paths...] --refactor-iife [--emit] [--emit-host] [--json]',
        '  node packages/@awesome-os/stealifylang-cli/lint-cli.mts --stdio',
      ].join('\n')
    )
    process.exit(0)
    return
  }

  const jsonMode = args.includes('--json')
  const sarifMode = args.includes('--sarif')
  const fixMode = args.includes('--fix')
  const failOnError = args.includes('--fail-on-error')
  const refactorIifeMode = args.includes('--refactor-iife')
  const emitMode = args.includes('--emit')
  const emitHostMode = args.includes('--emit-host')
  const sevIdx = args.indexOf('--severity')
  const sevRaw = sevIdx >= 0 ? (args[sevIdx + 1] ?? '').toLowerCase() : ''
  const maxSeverity = sevRaw === 'error' ? 1 : sevRaw === 'warn' ? 2 : 4

  const targets: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--severity') {
      i++
      continue
    }
    if (!a.startsWith('-')) targets.push(a)
  }
  const scanTargets = targets.length > 0 ? targets : ['.']

  if (refactorIifeMode) {
    const collectTsFiles = (inputs: readonly string[]): string[] => {
      const out: string[] = []
      const stack = inputs.map((t) => path.resolve(t))
      while (stack.length > 0) {
        const cur = stack.pop()!
        if (!fs.existsSync(cur)) continue
        const st = fs.statSync(cur)
        if (st.isDirectory()) {
          for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
            if (['node_modules', '.git', 'dist', 'out', 'build', 'deps', 'third_party'].includes(ent.name) || ent.name.startsWith('.')) {
              continue
            }
            stack.push(path.join(cur, ent.name))
          }
        } else if (st.isFile()) {
          const ext = path.extname(cur).toLowerCase()
          if (['.mts', '.ts', '.mjs', '.js'].includes(ext) && !cur.endsWith('.d.ts') && !isHostBoundaryFile(cur)) {
            out.push(cur)
          }
        }
      }
      return out.sort()
    }

    const candidateFiles = collectTsFiles(scanTargets)
    const results: Array<{
      filePath: string
      changed: boolean
      emitted: boolean
      factoryName: string
      capabilitiesInterfaceName: string
      requiredCaps: Array<{ key: string; typeName: string }>
      exportedValues: string[]
      code?: string
      hostFilePath?: string
      hostCode?: string
    }> = []

    for (const fp of candidateFiles) {
      const raw = fs.readFileSync(fp, 'utf8')
      const ref = refactorToCapabilityIife(raw, { filePath: fp })
      if (!ref.changed) continue
      const host = emitHostMode ? emitCapabilityHostAdapter(ref, fp) : null
      if (emitMode) {
        fs.writeFileSync(fp, ref.code, 'utf8')
        if (host) {
          fs.writeFileSync(host.hostFilePath, host.hostCode, 'utf8')
        }
      }
      results.push({
        filePath: fp,
        changed: true,
        emitted: emitMode,
        factoryName: ref.factoryName,
        capabilitiesInterfaceName: ref.capabilitiesInterfaceName,
        requiredCaps: ref.requiredCaps.map((c) => ({ key: c.key, typeName: c.typeName })),
        exportedValues: ref.exportedValues,
        code: emitMode ? undefined : ref.code,
        hostFilePath: host?.hostFilePath,
        hostCode: emitMode || !host ? undefined : host.hostCode,
      })
    }

    if (jsonMode) {
      console.log(JSON.stringify({ mode: emitMode ? 'emit' : 'offer', count: results.length, files: results }, null, 2))
    } else if (results.length === 0) {
      console.log('stealify-lint --refactor-iife: all scanned modules already comply with capability injection.')
    } else {
      for (const r of results) {
        if (emitMode) {
          console.log(`[EMITTED] ${r.filePath} -> ${r.factoryName}(caps: ${r.capabilitiesInterfaceName})${r.hostFilePath ? ` + ${r.hostFilePath}` : ''}`)
        } else {
          console.log(`=== [OFFER] ${r.filePath} -> ${r.factoryName}(${r.requiredCaps.map((c) => `${c.key}: ${c.typeName}`).join(', ')}) ===`)
          console.log(r.code ?? '')
          if (r.hostCode) {
            console.log(`--- [OFFER HOST BINDER] ${r.hostFilePath} ---`)
            console.log(r.hostCode)
          }
          console.log(`Hint: pass --emit${emitHostMode ? ' --emit-host' : ''} to write changes to disk.`)
        }
      }
    }
    return
  }

  const useCas = !args.includes('--no-cas')
  const casDiskPath = path.join(process.cwd(), '.stealify', 'lint-cas.json')
  const casStore = useCas ? new BlockCasStore(casDiskPath) : undefined

  const res = await scanAndAuditPathsAsync(scanTargets, {
    applyFixes: fixMode,
    auditor: casStore ? (fp, txt) => auditSourceTextWithCas(fp, txt, casStore) : undefined,
  })

  if (casStore) {
    casStore.persist()
  }

  const visible = maxSeverity < 4 ? res.diagnostics.filter((d) => d.severity <= maxSeverity) : res.diagnostics

  if (sarifMode) {
    const sarif = {
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'stealify-lint', version: '1.0.0' } },
          results: visible.map((d) => ({
            ruleId: d.code,
            level: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'note',
            message: { text: d.message },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: pathToFileURL(d.filePath).toString() },
                  region: {
                    startLine: d.range.start.line + 1,
                    startColumn: d.range.start.character + 1,
                  },
                },
              },
            ],
          })),
        },
      ],
    }
    console.log(JSON.stringify(sarif, null, 2))
  } else if (jsonMode) {
    console.log(
      JSON.stringify(
        { ...res, diagnostics: visible, casMetrics: casStore ? casStore.getMetrics() : undefined },
        null,
        2
      )
    )
  } else {
    console.log(
      formatTextReport(visible, res.filesScanned, res.filesSkipped, res.durationMs, casStore ? casStore.getMetrics() : undefined)
    )
  }

  if (failOnError && res.diagnostics.some((d) => d.severity === 1)) {
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main()
}
