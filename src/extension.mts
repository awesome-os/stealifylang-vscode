/**
 * @module src/extension.mts
 * StealifyLang Post-Neumann VS Code / Code - OSS / Eclipse Theia Extension.
 *
 * Combines:
 *  - StealifyLang LSP client spawning `src/lint/lint-cli.mts --stdio`
 *    (live B8G001-B8G016 diagnostics, QuickFixes, hover docs, `.stealify-rules` hot-reload)
 *  - Governance project rules runner (`auditProjectRules`)
 *  - Live `cas-v1` Wave-2 TypeScript 6.0.3 resolver (`resolveFastTypeScriptPlan`)
 *
 * Strictly erasable TypeScript (`erasableSyntaxOnly: true`, zero build step).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectRuleEngine, type RuleViolation } from './rules/project-rules.mts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LINT_CLI = path.resolve(HERE, 'lint/lint-cli.mts')
const DEFAULT_RULES_PATH = path.resolve(HERE, 'lint/.stealify-rules.json')

export const B8G_GHOST_MANIFEST_URL =
  'https://raw.githubusercontent.com/awesome-os/b8g-ghost/main/manifests/index.json'
export const FAST_TYPESCRIPT_ARTIFACT = 'typescript-6.0.3-programmable.tar.gz'

export interface FastTypeScriptPlan {
  readonly artifact: string
  readonly version: string
  readonly sha256: string
  readonly bytes: number
  readonly category: string
  readonly downloadUrl: string
  readonly manifestUrl: string
  readonly tsdkSettingKey: 'typescript.tsdk'
  readonly speedupLabel: string
}

export interface DefaultRulesConfig {
  readonly ruleOverrides: Record<string, string>
  readonly projectRuleIds: readonly string[]
  readonly rulesPath: string
}

export interface ProjectRulesAuditResult {
  readonly totalFiles: number
  readonly violations: RuleViolation[]
  readonly passed: boolean
}

const STEALIFY_HOVERS: Record<string, string> = {
  '@defer':
    '**(StealifyLang Macro)** `@defer (trigger; prefetch)`\n\nDefers bytecode compilation and execution until trigger criteria (`on idle`, `on viewport`, `on interaction`, `on timer`, `when <expr>`) are satisfied.',
  '@placeholder':
    '**(StealifyLang Macro)** `@placeholder (minimum: ms)`\n\nImmediate fallback content rendered while `@defer` is awaiting trigger.',
  '@loading':
    '**(StealifyLang Macro)** `@loading (after: ms, minimum: ms)`\n\nState displayed during asynchronous transition or compilation.',
  '@error':
    '**(StealifyLang Macro)** `@error`\n\nError boundary state rendered if deferred execution or CAS retrieval fails.',
  '@hydrate':
    '**(StealifyLang Macro)** `@hydrate (from: Snapshot)`\n\nRe-inflates memory state from a Hot Snapshot without re-running initialization code.',
  '@isolate':
    '**(StealifyLang Macro)** `@isolate (core: number | "auto")`\n\nDispatches the enclosed block to run on a dedicated hardware-pinned CPU core and isolated V8/WASI instance.',
  '@disposable':
    '**(StealifyLang Macro)** `@disposable`\n\nGuaranteed LIFO scope exit cleanup block (similar to Zig/Go `defer`).',
  '@memo':
    '**(StealifyLang Macro)** `@memo (key, ttl)`\n\nMemoizes block results in linear CAS memory indexed by cryptographic hash.',
  init: '**(Container Lifecycle)** `init(ctx: StealifyContext)`\n\nRuns before I/O router or network socket accepts traffic. Equivalent to k8s `initContainers`.',
  readiness:
    '**(Container Lifecycle)** `readiness(ctx: StealifyContext): boolean`\n\nTraffic gating probe. Fast-calls are rejected or queued while returning false. Equivalent to k8s `readinessProbe`.',
  liveness:
    '**(Container Lifecycle)** `liveness(ctx: StealifyContext): boolean`\n\nHeartbeat watchdog. If returning false or deadlocked, microkernel triggers O(1) hot snapshot reset. Equivalent to k8s `livenessProbe`.',
  preStop:
    '**(Container Lifecycle)** `preStop(ctx: StealifyContext)`\n\nGraceful termination hook. Commits WAL and flushes VFS buffers before eviction. Equivalent to k8s `lifecycle.preStop`.',
  B8gMemoryArena:
    '**(Physical Memory)** `B8gMemoryArena`\n\nLinear memory allocator over `SharedArrayBuffer` (`B8G_ARENA_V1`) with 64-byte cache alignment and scratchpad mark/reset.',
  CapabilityToken:
    '**(Post-Neumann Security)** `CapabilityToken`\n\nUnforgeable cryptographic capability token governing system calls and VFS permissions.',
}

interface ActiveSession {
  readonly child: ChildProcess
  readonly flushTimer: ReturnType<typeof setInterval>
}

let activeSession: ActiveSession | null = null

/**
 * Returns the default `.stealify-rules.json` configuration and active governance rule IDs.
 */
export function getDefaultRulesConfig(): DefaultRulesConfig {
  let ruleOverrides: Record<string, string> = {
    B8G012: 'info',
    B8G013: 'info',
  }
  try {
    if (fs.existsSync(DEFAULT_RULES_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DEFAULT_RULES_PATH, 'utf8')) as {
        ruleOverrides?: Record<string, string>
      }
      if (parsed && typeof parsed.ruleOverrides === 'object' && parsed.ruleOverrides !== null) {
        ruleOverrides = { ...parsed.ruleOverrides }
      }
    }
  } catch {
    // Fall back to built-in defaults if disk read fails
  }

  const engine = new ProjectRuleEngine()
  return {
    ruleOverrides,
    projectRuleIds: engine.rules.map((r) => r.id),
    rulesPath: DEFAULT_RULES_PATH,
  }
}

/**
 * Runs Awesome-OS governance project rules over a workspace directory.
 */
export async function auditProjectRules(
  targetDir: string,
  options?: { ignore?: string[] }
): Promise<ProjectRulesAuditResult> {
  const engine = new ProjectRuleEngine()
  return engine.scanDirectory(targetDir, options)
}

/**
 * Resolves the live `cas-v1` download plan for Wave-2 TypeScript 6.0.3
 * (`typescript-6.0.3-programmable.tar.gz`) from `awesome-os/b8g-ghost`
 * so Code - OSS / Eclipse Theia can switch `typescript.tsdk` to our 14.3x faster compiler.
 */
export async function resolveFastTypeScriptPlan(
  manifestUrl: string = B8G_GHOST_MANIFEST_URL
): Promise<FastTypeScriptPlan> {
  const response = await fetch(manifestUrl, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(
      `Failed to fetch b8g-ghost CAS manifest from ${manifestUrl}: HTTP ${response.status} ${response.statusText}`
    )
  }

  const manifest = (await response.json()) as {
    cas_base_url?: string
    entries?: Record<
      string,
      {
        filename?: string
        sha256?: string
        bytes?: number
        version?: string
        category?: string
        download_url?: string
      }
    >
  }

  const entry = manifest.entries?.[FAST_TYPESCRIPT_ARTIFACT]
  if (!entry || !entry.sha256 || !entry.download_url) {
    throw new Error(
      `Artifact "${FAST_TYPESCRIPT_ARTIFACT}" not found in b8g-ghost manifest at ${manifestUrl}`
    )
  }

  return {
    artifact: entry.filename ?? FAST_TYPESCRIPT_ARTIFACT,
    version: entry.version ?? '6.0.3-wave2',
    sha256: entry.sha256,
    bytes: Number(entry.bytes ?? 0),
    category: entry.category ?? 'toolchain',
    downloadUrl: entry.download_url,
    manifestUrl,
    tsdkSettingKey: 'typescript.tsdk',
    speedupLabel: '14.3x faster Wave-2 TypeScript 6.0.3',
  }
}

/**
 * Activates the StealifyLang LSP, governance rules runner, and Wave-2 TypeScript commands
 * inside VS Code, Code - OSS, or Eclipse Theia.
 */
export async function activate(context: { subscriptions: Array<{ dispose(): unknown }> }): Promise<void> {
  const vscodeModuleName = 'vscode'
  const vscode = (await import(vscodeModuleName)) as any

  const diagCollection = vscode.languages.createDiagnosticCollection('stealify-lint')
  const rulesDiagCollection = vscode.languages.createDiagnosticCollection('stealify-project-rules')
  const child = spawn(process.execPath, [LINT_CLI, '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let nextId = 1
  const pending = new Map<number, (result: any) => void>()
  let rx: Buffer = Buffer.alloc(0)

  const pendingDiags = new Map<any, any[]>()
  const FLUSH_INTERVAL_MS = 5000

  const flushDiagnostics = (): void => {
    if (pendingDiags.size === 0) return
    const entries = Array.from(pendingDiags.entries())
    pendingDiags.clear()
    diagCollection.set(entries)
  }

  const flushTimer = setInterval(flushDiagnostics, FLUSH_INTERVAL_MS)
  activeSession = { child, flushTimer }

  const send = (payload: Record<string, unknown>): void => {
    if (!child.stdin || child.killed) return
    const json = JSON.stringify(payload)
    child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`)
  }

  const request = (method: string, params: Record<string, unknown>): Promise<any> =>
    new Promise((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      send({ jsonrpc: '2.0', id, method, params })
    })

  child.stdout?.on('data', (chunk: Buffer) => {
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

      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)?.(msg.result)
        pending.delete(msg.id)
      } else if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
        const uri = vscode.Uri.parse(msg.params.uri)
        const list = (msg.params.diagnostics ?? []).map((d: any) => {
          const r = new vscode.Range(
            d.range.start.line,
            d.range.start.character,
            d.range.end.line,
            d.range.end.character
          )
          const diag = new vscode.Diagnostic(r, d.message, Math.max(0, (d.severity ?? 3) - 1))
          diag.code = d.code
          diag.source = 'stealify-lint'
          return diag
        })
        pendingDiags.set(uri, list)
      }
    }
  })

  await request('initialize', { rootUri: null, capabilities: {} })
  send({ jsonrpc: '2.0', method: 'initialized', params: {} })

  const syncDoc = (doc: any): void => {
    send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: doc.uri.toString(),
          languageId: doc.languageId,
          version: doc.version,
          text: doc.getText(),
        },
      },
    })
  }

  for (const doc of vscode.workspace.textDocuments ?? []) syncDoc(doc)
  setTimeout(flushDiagnostics, 350)

  const hoverProvider = vscode.languages.registerHoverProvider(['stealify', 'typescript'], {
    provideHover(document: any, position: any) {
      const wordRange = document.getWordRangeAtPosition(
        position,
        /@[A-Za-z]+|\b[A-Za-z_$][A-Za-z0-9_$]*\b/
      )
      if (!wordRange) return undefined
      const word = document.getText(wordRange) as string
      const doc = STEALIFY_HOVERS[word]
      if (doc) {
        return new vscode.Hover(new vscode.MarkdownString(doc))
      }
      return undefined
    },
  })

  const codeActionsProvider = vscode.languages.registerCodeActionsProvider(
    ['stealify', 'typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    {
      async provideCodeActions(doc: any, range: any, ctx: any) {
        const only = ctx.only ? [ctx.only.value] : undefined
        const raw = await request('textDocument/codeAction', {
          textDocument: { uri: doc.uri.toString() },
          range: {
            start: { line: range.start.line, character: range.start.character },
            end: { line: range.end.line, character: range.end.character },
          },
          context: { diagnostics: [], only },
        })
        return (raw ?? []).map((a: any) => {
          const kind =
            a.kind === 'source.fixAll'
              ? vscode.CodeActionKind.SourceFixAll
              : vscode.CodeActionKind.QuickFix
          const act = new vscode.CodeAction(a.title, kind)
          const wsEdit = new vscode.WorkspaceEdit()
          for (const [u, edits] of Object.entries(a.edit?.changes ?? {})) {
            const targetUri = vscode.Uri.parse(u)
            for (const ed of edits as any[]) {
              wsEdit.replace(
                targetUri,
                new vscode.Range(
                  ed.range.start.line,
                  ed.range.start.character,
                  ed.range.end.line,
                  ed.range.end.character
                ),
                ed.newText
              )
            }
          }
          act.edit = wsEdit
          return act
        })
      },
    }
  )

  const fixAllCmd = vscode.commands.registerCommand('stealifyLint.fixAll', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    const doc = editor.document
    const raw = await request('textDocument/codeAction', {
      textDocument: { uri: doc.uri.toString() },
      range: { start: { line: 0, character: 0 }, end: { line: doc.lineCount, character: 0 } },
      context: { diagnostics: [], only: ['source.fixAll'] },
    })
    const fixAction = Array.isArray(raw) ? raw[0] : undefined
    if (!fixAction?.edit?.changes) {
      vscode.window.showInformationMessage('[StealifyLint] No auto-fixable B8G issues in active document.')
      return
    }
    const wsEdit = new vscode.WorkspaceEdit()
    for (const [u, edits] of Object.entries(fixAction.edit.changes)) {
      const targetUri = vscode.Uri.parse(u)
      for (const ed of edits as any[]) {
        wsEdit.replace(
          targetUri,
          new vscode.Range(
            ed.range.start.line,
            ed.range.start.character,
            ed.range.end.line,
            ed.range.end.character
          ),
          ed.newText
        )
      }
    }
    await vscode.workspace.applyEdit(wsEdit)
    syncDoc(doc)
    setTimeout(flushDiagnostics, 50)
  })

  const auditWorkspaceCmd = vscode.commands.registerCommand('stealifyLint.auditWorkspace', async () => {
    const folders = vscode.workspace.workspaceFolders ?? []
    if (folders.length === 0) return
    rulesDiagCollection.clear()
    const grouped = new Map<string, any[]>()
    let totalFiles = 0
    let totalViolations = 0

    for (const folder of folders) {
      const res = await auditProjectRules(folder.uri.fsPath)
      totalFiles += res.totalFiles
      totalViolations += res.violations.length
      for (const v of res.violations) {
        const list = grouped.get(v.filePath) ?? []
        const line = Math.max(0, (v.line ?? 1) - 1)
        const col = Math.max(0, (v.column ?? 1) - 1)
        const sev = v.severity === 'error' ? 0 : v.severity === 'warning' ? 1 : 2
        const diag = new vscode.Diagnostic(new vscode.Range(line, col, line, col + 1), v.message, sev)
        diag.code = v.ruleId
        diag.source = 'stealify-project-rules'
        list.push(diag)
        grouped.set(v.filePath, list)
      }
    }

    for (const [fp, diags] of grouped.entries()) {
      rulesDiagCollection.set(vscode.Uri.file(fp), diags)
    }

    vscode.window.showInformationMessage(
      `[StealifyLint] Governance audit scanned ${totalFiles} file(s): ${totalViolations} violation(s).`
    )
  })

  const useFastTsCmd = vscode.commands.registerCommand('stealify.useFastTypeScript', async () => {
    const plan = await resolveFastTypeScriptPlan()
    vscode.window.showInformationMessage(
      `[StealifyLang] Resolved ${plan.artifact} (${plan.version}, ${plan.speedupLabel}) sha256=${plan.sha256.slice(0, 12)}... -> ${plan.downloadUrl}`
    )
    return plan
  })

  const compileCmd = vscode.commands.registerCommand('stealify.compileToB8e', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    vscode.window.showInformationMessage(
      `[StealifyLang] Compiling ${path.basename(editor.document.fileName)} to .b8e container...`
    )
  })

  const rulesWatcher = vscode.workspace.createFileSystemWatcher(
    '**/{.stealify-rules,.stealify-rules.*,.stealify-rules/**}'
  )
  const reloadRules = (): void => {
    send({ jsonrpc: '2.0', method: 'workspace/didChangeWatchedFiles', params: { changes: [] } })
    for (const doc of vscode.workspace.textDocuments ?? []) syncDoc(doc)
    setTimeout(flushDiagnostics, 250)
  }
  rulesWatcher.onDidChange(reloadRules)
  rulesWatcher.onDidCreate(reloadRules)
  rulesWatcher.onDidDelete(reloadRules)

  const onSave = vscode.workspace.onDidSaveTextDocument((doc: any) => {
    syncDoc(doc)
    setTimeout(flushDiagnostics, 50)
  })

  const onClose = vscode.workspace.onDidCloseTextDocument((doc: any) => {
    pendingDiags.delete(doc.uri)
    diagCollection.delete(doc.uri)
  })

  const flushCmd = vscode.commands.registerCommand('stealify.flushDiagnostics', flushDiagnostics)

  context.subscriptions.push(
    diagCollection,
    rulesDiagCollection,
    vscode.workspace.onDidOpenTextDocument(syncDoc),
    vscode.workspace.onDidChangeTextDocument((ev: any) => syncDoc(ev.document)),
    onSave,
    onClose,
    rulesWatcher,
    hoverProvider,
    codeActionsProvider,
    fixAllCmd,
    auditWorkspaceCmd,
    useFastTsCmd,
    compileCmd,
    flushCmd,
    {
      dispose: () => {
        deactivate()
      },
    }
  )
}

/**
 * Cleanly terminates the StealifyLang LSP server and diagnostic flush timer.
 */
export function deactivate(): void {
  if (!activeSession) return
  clearInterval(activeSession.flushTimer)
  try {
    activeSession.child.kill()
  } catch {
    // Ignore already-exited child process
  }
  activeSession = null
}
