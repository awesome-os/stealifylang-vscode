/**
 * @module
 * Stealify Runtime & Kernel Boundary Audit Engine (`B8G001`–`B8G013`).
 *
 * Single-pass, zero-dependency static pattern analyzer catching V8, libuv,
 * Electron, Deno, Web-Fetch, CPython, and Ambient Host Authority traps that
 * conventional syntax linters miss.
 */

import fs from 'node:fs'
import path from 'node:path'
import { scanHostCoupling } from './capability-iife-refactor.mts'

export type AuditSeverity = 1 | 2 | 3 | 4 // LSP: 1=Error, 2=Warning, 3=Info, 4=Hint

export type CustomRuleSeverityInput = 1 | 2 | 3 | 4 | 'error' | 'warn' | 'warning' | 'info' | 'hint'

export interface CustomRuleContext {
  filePath: string
  text: string
  lines: string[]
  lineStarts: number[]
}

export interface CustomRuleDiagnosticMatch {
  line: number // 0-based
  character: number // 0-based
  length?: number
  message?: string
  severity?: CustomRuleSeverityInput
  fix?: {
    title?: string
    replacement: string
    startOffset?: number
    endOffset?: number
  }
}

export interface CustomStealifyRule {
  id: string
  severity?: CustomRuleSeverityInput
  message: string | ((match: RegExpExecArray | null, ctx: CustomRuleContext) => string)
  pattern?: RegExp | string
  files?: string[] | RegExp | string
  exclude?: string[] | RegExp | string
  fix?:
    | string
    | ((
        match: RegExpExecArray | null,
        ctx: CustomRuleContext
      ) => string | { title?: string; replacement: string; startOffset?: number; endOffset?: number })
  fixTitle?: string
  inspect?: (ctx: CustomRuleContext) => CustomRuleDiagnosticMatch[]
}

export interface AuditPosition {
  line: number // 0-based (LSP)
  character: number // 0-based
}

export interface AuditRange {
  start: AuditPosition
  end: AuditPosition
}

export interface AuditFix {
  title: string
  startOffset: number
  endOffset: number
  replacement: string
}

export interface AuditDiagnostic {
  code: string
  severity: AuditSeverity
  message: string
  filePath: string
  range: AuditRange
  fix?: AuditFix
}

export interface AuditRunResult {
  filesScanned: number
  filesSkipped: number
  durationMs: number
  diagnostics: AuditDiagnostic[]
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'deps',
  'third_party',
  'coverage',
  '.venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.stealify-adapt',
])

const DEFAULT_MAX_FILE_BYTES = 512 * 1024
const JS_TS_EXTS = new Set(['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.cjs', '.stealify'])
const PY_EXTS = new Set(['.py'])
const HTML_EXTS = new Set(['.html', '.htm'])
const MD_EXTS = new Set(['.md', '.markdown'])
const DECLARATIVE_SECTION_ENTRY_RE = /(^|\/)(sections|intersections)\/[^/]+\/index\.mts$/
const INTERSECTION_ENTRY_RE = /(^|\/)intersections\/[^/]+\/index\.mts$/
const DEVOPS_INTERSECTION_ENTRY_RE = /(^|\/)intersections\/b8g-devops\/index\.mts$/i

interface FrameworkRuleEntry {
  code: string
  category: string
  alternative: string
  fixTo?: string
}

const JS_FRAMEWORK_MAP: Record<string, FrameworkRuleEntry> = {
  express: {
    code: 'B8G101',
    category: 'HTTP server framework',
    alternative: 'Use `b8g-router` (`SabRouter`) + `2.4 KB` universal WASM Trie or raw `node:net` wire dispatch (eliminates middleware/req object bloat).',
  },
  fastify: {
    code: 'B8G101',
    category: 'HTTP server framework',
    alternative: 'Use Web-Standards `SabRouter` (`b8g-router/wasm`) with flat `SharedArrayBuffer` dispatch and zero decorator wrappers.',
  },
  koa: {
    code: 'B8G101',
    category: 'HTTP server framework',
    alternative: 'Use Web-Standards `SabRouter` (`b8g-router`) with native `fetch(Request)` parity and zero per-request ctx allocation.',
  },
  axios: {
    code: 'B8G102',
    category: 'HTTP client library',
    alternative: 'Use built-in global `fetch(url, init)` + `AbortSignal.timeout()` natively supported in Node 22+, Deno, Bun, and Browsers.',
  },
  got: {
    code: 'B8G102',
    category: 'HTTP client library',
    alternative: 'Use built-in global `fetch()` instead of pulling legacy HTTP stream wrappers.',
  },
  'node-fetch': {
    code: 'B8G102',
    category: 'HTTP client polyfill',
    alternative: 'Remove `node-fetch`; standard `fetch`, `Request`, `Response`, and `Headers` are built into Node 22+, Deno, and Bun.',
  },
  'fs-extra': {
    code: 'B8G103',
    category: 'Filesystem wrapper library',
    alternative: 'Use built-in `node:fs` (`mkdirSync(..., { recursive: true })`, `cpSync(..., { recursive: true })`, `rmSync(..., { recursive: true, force: true })`) or pack static assets with `b8g-pack`.',
  },
  rimraf: {
    code: 'B8G103',
    category: 'Filesystem delete wrapper',
    alternative: 'Use native `fs.rmSync(target, { recursive: true, force: true })` (0 dependencies).',
  },
  mkdirp: {
    code: 'B8G103',
    category: 'Filesystem mkdir wrapper',
    alternative: 'Use native `fs.mkdirSync(dir, { recursive: true })` (0 dependencies).',
  },
  glob: {
    code: 'B8G103',
    category: 'Glob walker wrapper',
    alternative: 'Use native `fs.globSync` / pruned `fs.opendirSync` stack, or pre-index trees via `b8g-pack`.',
  },
  'fast-glob': {
    code: 'B8G103',
    category: 'Glob walker wrapper',
    alternative: 'Use pruned `fs.opendirSync` stack or prebuilt `.b8p` linear asset table (`b8g-pack`).',
  },
  lodash: {
    code: 'B8G104',
    category: 'Utility barrel library',
    alternative: 'Use native JS (`structuredClone`, `Object.groupBy`, `Map`/`Set`, array methods) directly with zero bundle weight.',
  },
  'lodash-es': {
    code: 'B8G104',
    category: 'Utility barrel library',
    alternative: 'Replace with direct Web/ES built-ins (`structuredClone`, `Object.groupBy`, `Map`/`Set`).',
  },
  underscore: {
    code: 'B8G104',
    category: 'Utility barrel library',
    alternative: 'Replace with native ES array/object methods.',
  },
  uuid: {
    code: 'B8G104',
    category: 'UUID wrapper',
    alternative: 'Use built-in `crypto.randomUUID()` natively available in Node, Deno, Bun, and Web Crypto.',
  },
  webpack: {
    code: 'B8G105',
    category: 'Legacy bundler',
    alternative: 'Run native `.mts` directly (Node 22+, Deno, Bun) or build direct ESM + `.wasm` + `.b8p` via `stealify-adapt build`.',
  },
  rollup: {
    code: 'B8G105',
    category: 'Legacy bundler',
    alternative: 'Use direct ESNext modules via Stealify `emitStealifyEsmModules` and pack static assets with `b8g-pack`.',
  },
  '@electron/asar': {
    code: 'B8G106',
    category: 'Legacy Electron `.asar` archive',
    alternative: 'Replace `.asar` JSON manifests with zero-parse `b8g-pack` (`app.b8p` + nested `frontend.b8p`, `~78%` smaller & `~1 ms` boot).',
  },
  asar: {
    code: 'B8G106',
    category: 'Legacy Electron `.asar` archive',
    alternative: 'Replace `.asar` with `b8g-pack` (`app.b8p`) + `protocol.handle` / 1-blob `Cache API` Service Worker.',
  },
  next: {
    code: 'B8G107',
    category: 'Heavy meta-framework',
    alternative: 'Consider serving pre-rendered static/islands via `b8g-pack` (`.b8p`) + lightweight `b8g-router` API endpoints without multi-MB runtime hydration.',
  },
  nuxt: {
    code: 'B8G107',
    category: 'Heavy meta-framework',
    alternative: 'Consider `b8g-pack` + `b8g-router` Web-Standards SSR/static delivery instead of heavy meta-framework layers.',
  },
  'reflect-metadata': {
    code: 'B8G108',
    category: 'Runtime decorator/reflection tax',
    alternative: 'Use explicit constructors, fixed property initialization, and zero-reflection typed schemas.',
  },
  'class-transformer': {
    code: 'B8G108',
    category: 'Reflection DTO mapper',
    alternative: 'Map plain objects directly with monomorphic helper functions (zero decorator metadata traversal).',
  },
  moment: {
    code: 'B8G109',
    category: 'Heavy legacy date library',
    alternative: 'Use built-in `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat`, or native `Date.now()` / `Temporal`.',
  },
  'moment-timezone': {
    code: 'B8G109',
    category: 'Heavy legacy timezone library',
    alternative: 'Use built-in `Intl.DateTimeFormat(locale, { timeZone })` (`0 B` timezone database ship cost).',
  },
  ink: {
    code: 'B8G111',
    category: 'React Fiber terminal UI renderer',
    alternative: 'Use `@awesome-os/sab-react/tty` (`renderTtyApp`, `Box`, `Text` — zero Fiber/Yoga reconciliation overhead over `SabUiSlab`).',
    fixTo: '@awesome-os/sab-react/tty',
  },
  'react-reconciler': {
    code: 'B8G111',
    category: 'Heavy custom React Fiber host reconciler',
    alternative: 'Replace custom `react-reconciler` host configs with a `DomPatchTarget` adapter (`@awesome-os/sab-react/tty`, `@awesome-os/sab-react/pdf`) over `SabUiSlab`.',
  },
  '@react-pdf/renderer': {
    code: 'B8G111',
    category: 'React Fiber PDF layout reconciler',
    alternative: 'Use `@awesome-os/sab-react/pdf` (`renderToPdfBytes`, `PdfDocumentBuilder` — single-pass Web-Standards PDF 1.4 `Uint8Array` emitter).',
    fixTo: '@awesome-os/sab-react/pdf',
  },
  'react-pdf': {
    code: 'B8G111',
    category: 'Heavy React Fiber PDF wrapper',
    alternative: 'Use `@awesome-os/sab-react/pdf` (`renderToPdfBytes`, `PdfDocumentBuilder`) or native `<object>`/`pdf.js` Worker streaming.',
    fixTo: '@awesome-os/sab-react/pdf',
  },
  yjs: {
    code: 'B8G112',
    category: 'Heap-object CRDT document graph',
    alternative: 'Use `@awesome-os/sab-react/sync` (`SabCrdtReplica` + `SabDeltaRing` + `.esar` checkpoints) over flat SharedArrayBuffer slots.',
  },
  automerge: {
    code: 'B8G112',
    category: 'Heavy CRDT JSON document abstraction',
    alternative: 'Use `@awesome-os/sab-react/sync` (`SabCrdtReplica` + `SabDeltaRing` + `.esar` checkpoints) for zero-serialization SAB replication.',
  },
  'react-window': {
    code: 'B8G113',
    category: 'VDOM virtualized list wrapper',
    alternative: 'Use `@awesome-os/sab-react/grid` (`SabVirtualGrid`, `useVirtualWindow` — modulo row-pool recycling with zero DOM churn).',
  },
  'react-virtualized': {
    code: 'B8G113',
    category: 'Heavy Fiber virtualized list + CellMeasurer',
    alternative: 'Use `@awesome-os/sab-react/grid` (`SabVirtualGrid`, `VariableHeightIndex` — O(log N) Fenwick heights with zero `getBoundingClientRect`).',
  },
  '@tanstack/react-table': {
    code: 'B8G113',
    category: 'JS row-model object wrapper table',
    alternative: 'Use `@awesome-os/sab-react/grid` (`SabTableColumnarIndex`, `SabVirtualGrid` — SAB typed-array filter/sort over 100k+ rows).',
  },
  'ag-grid-react': {
    code: 'B8G113',
    category: 'Heavy React Fiber datagrid wrapper',
    alternative: 'Use `@awesome-os/sab-react/grid` (`SabTableColumnarIndex`, `SabVirtualGrid`) for zero-Fiber high-frequency grid slots.',
  },
  recharts: {
    code: 'B8G114',
    category: 'VDOM SVG chart reconciliation library',
    alternative: 'Use `@awesome-os/sab-react/charts` (`SabChartSeries` Float32Array ring + `mountSabChart`) for zero-VDOM plot updates.',
  },
  'chart.js': {
    code: 'B8G114',
    category: 'Imperative chart wrapper',
    alternative: 'Use `@awesome-os/sab-react/charts` (`SabChartSeries.buildBarRects` / `buildLinePathD`) or `@awesome-os/sab-react/gpu` quads.',
  },
  'react-chartjs-2': {
    code: 'B8G114',
    category: 'React Fiber wrapper over Chart.js',
    alternative: 'Use `@awesome-os/sab-react/charts` (`SabChartSeries`, `mountSabChart`) directly over `Float32Array` telemetry.',
  },
  victory: {
    code: 'B8G114',
    category: 'Heavy VDOM SVG chart framework',
    alternative: 'Use `@awesome-os/sab-react/charts` (`SabChartSeries`) without per-point React SVG elements.',
  },
  '@nivo/core': {
    code: 'B8G114',
    category: 'Heavy Nivo SVG/motion charting bundle',
    alternative: 'Use `@awesome-os/sab-react/charts` (`SabChartSeries`) directly.',
  },
  'framer-motion': {
    code: 'B8G115',
    category: 'React render-tree animation & layout-projection engine',
    alternative: 'Use `@awesome-os/sab-react/motion` (`SabMotionEngine`, `useSpringSlot`) in `Float32Array` slots off the React render loop.',
  },
  motion: {
    code: 'B8G115',
    category: 'React/JS animation runtime wrapper',
    alternative: 'Use `@awesome-os/sab-react/motion` (`SabMotionEngine`) mutating `SabUiSlab` numeric slots directly.',
  },
  'react-spring': {
    code: 'B8G115',
    category: 'React spring physics reconciler',
    alternative: 'Use `@awesome-os/sab-react/motion` (`SabMotionEngine`, `useSpringSlot`).',
  },
  '@react-spring/web': {
    code: 'B8G115',
    category: 'React spring DOM adapter',
    alternative: 'Use `@awesome-os/sab-react/motion` (`SabMotionEngine`, `useSpringSlot`).',
  },
  '@radix-ui/react-dialog': {
    code: 'B8G116',
    category: 'Ref-chasing headless React dialog wrapper',
    alternative: 'Use `@awesome-os/sab-react/a11y` (`useDialogPrimitive` + `OP_SET_ATTR`) without Fiber portal trees.',
  },
  '@radix-ui/react-tabs': {
    code: 'B8G116',
    category: 'Ref-chasing headless React tabs wrapper',
    alternative: 'Use `@awesome-os/sab-react/a11y` (`useTabsPrimitive` + `OP_SET_ATTR`).',
  },
  '@headlessui/react': {
    code: 'B8G116',
    category: 'Headless React UI Fiber wrapper',
    alternative: 'Use `@awesome-os/sab-react/a11y` (`useDialogPrimitive`, `useTabsPrimitive`, `useListboxPrimitive`).',
  },
  'react-aria': {
    code: 'B8G116',
    category: 'Multi-package React DOM ref ARIA hook runtime',
    alternative: 'Use `@awesome-os/sab-react/a11y` binary `OP_SET_ATTR` primitives.',
  },
  gatsby: {
    code: 'B8G117',
    category: 'Heavy static GraphQL site generator',
    alternative: 'Use native `.mts` static emission + `b8g-pack` (`.b8p`) + `@awesome-os/sab-react`.',
  },
  '@remix-run/react': {
    code: 'B8G117',
    category: 'Full-stack React SSR router wrapper',
    alternative: 'Use `b8g-router` WASM trie + `@awesome-os/sab-react/compat`.',
  },
  '@vercel/analytics': {
    code: 'B8G117',
    category: 'Proprietary edge SaaS telemetry lock-in',
    alternative: 'Collect lightweight zero-alloc counters in your `b8g` edge server or Web-Standards beacon.',
  },
  '@prisma/client': {
    code: 'B8G118',
    category: 'Heavy runtime ORM + Rust engine bridge overhead',
    alternative: 'Use prepared native SQLite WAL (`node:sqlite` / `b8g-sqlite`) or DuckDB queries without ORM entity boxing.',
  },
  prisma: {
    code: 'B8G118',
    category: 'Heavy ORM schema codegen & runtime overhead',
    alternative: 'Use SQL migrations + typed SQLite WAL / DuckDB accessors.',
  },
  typeorm: {
    code: 'B8G118',
    category: 'Reflection ActiveRecord/DataMapper ORM',
    alternative: 'Use direct prepared SQL statements returning flat objects or typed slabs.',
  },
  '@apollo/client': {
    code: 'B8G118',
    category: 'Heavy normalized GraphQL cache + React context tree',
    alternative: 'Use direct HTTP/WebSocket `B8GS` binary delta frames or typed `fetch()` endpoints.',
  },
  graphql: {
    code: 'B8G118',
    category: 'Runtime AST query parser & executor bloat',
    alternative: 'Serve direct versioned routes in `b8g-router` (`2,416 B` WASM trie) with binary/JSON payloads.',
  },
  'styled-components': {
    code: 'B8G119',
    category: 'Runtime CSS-in-JS style injection + React context tax',
    alternative: 'Emit static CSS rules paired with `OP_SET_CLASS` slots in `@awesome-os/sab-react`.',
  },
  '@emotion/react': {
    code: 'B8G119',
    category: 'Runtime CSS-in-JS serializer + hash overhead',
    alternative: 'Use static CSS layers + `OP_SET_CLASS` (`SabUiSlab.setAsciiSlot`).',
  },
  '@emotion/styled': {
    code: 'B8G119',
    category: 'Runtime CSS-in-JS HOC wrapper',
    alternative: 'Use static CSS classes via `OP_SET_CLASS`.',
  },
  'dd-trace': {
    code: 'B8G120',
    category: 'Heavy monkey-patching cloud APM SDK',
    alternative: 'Emit zero-overhead linear histograms and structured edge logs without global `AsyncLocalStorage`/module hooks.',
  },
}

const PY_FRAMEWORK_MAP: Record<string, FrameworkRuleEntry> = {
  fastapi: {
    code: 'B8G110',
    category: 'Heavy ASGI Python framework',
    alternative: 'For static/edge routes, bypass ASGI `scope` dict & GIL hops via `b8g-pack` + `mmap`/`sock.fileno()` aligned C boundary; invoke Python handlers only for business logic.',
  },
  flask: {
    code: 'B8G110',
    category: 'WSGI Python framework',
    alternative: 'Offload static assets & routing below Python (`b8g-pack` + C/`memoryview` socket boundary) so WSGI request boxing runs only on dynamic endpoints.',
  },
  django: {
    code: 'B8G110',
    category: 'Monolithic Python framework',
    alternative: 'Offload `collectstatic`/media delivery to zero-`fs` `b8g-pack` and avoid `os.stat`/WhiteNoise Python middleware loops.',
  },
  requests: {
    code: 'B8G110',
    category: 'Sync blocking HTTP wrapper',
    alternative: 'Use stdlib `urllib.request` or connection-pooled native C/async clients without extra wrapper layers on hot paths.',
  },
}

function normalizePkgRoot(spec: string): string {
  if (spec.startsWith('@')) {
    const slash1 = spec.indexOf('/')
    if (slash1 === -1) return spec
    const slash2 = spec.indexOf('/', slash1 + 1)
    return slash2 === -1 ? spec : spec.slice(0, slash2)
  }
  const slash = spec.indexOf('/')
  return slash === -1 ? spec : spec.slice(0, slash)
}

function auditFrameworkImports(
  diags: AuditDiagnostic[],
  getLineStarts: () => number[],
  filePath: string,
  text: string,
  rules: Record<string, FrameworkRuleEntry>,
  isPython: boolean
): void {
  if (isPython) {
    if (!text.includes('import')) return
    const pyRe = /^[ \t]*(?:from|import)\s+([a-zA-Z0-9_]+)/gm
    let m: RegExpExecArray | null
    while ((m = pyRe.exec(text)) !== null) {
      const rule = rules[m[1]]
      if (!rule) continue
      pushDiag(
        diags,
        getLineStarts,
        filePath,
        rule.code,
        3,
        `Detected ${rule.category} \`${m[1]}\`: ${rule.alternative}`,
        m.index,
        m.index + m[0].length
      )
    }
    return
  }

  if (!text.includes('import') && !text.includes('require(')) return
  // Match ES import specifiers & CommonJS require('pkg')
  const jsRe = /(?:from\s+|import\s+|require\s*\(\s*)(['"])([^./][^'"]+)\1/g
  let m: RegExpExecArray | null
  while ((m = jsRe.exec(text)) !== null) {
    const rootPkg = normalizePkgRoot(m[2])
    const rule = rules[rootPkg]
    if (!rule) continue
    let fix: AuditFix | undefined
    if (rule.fixTo) {
      const specStart = m.index + m[0].length - m[1].length - m[2].length
      const specEnd = specStart + m[2].length
      fix = {
        title: `Rewrite \`${rootPkg}\` import -> \`${rule.fixTo}\``,
        startOffset: specStart,
        endOffset: specEnd,
        replacement: rule.fixTo,
      }
    }
    pushDiag(
      diags,
      getLineStarts,
      filePath,
      rule.code,
      3,
      `Detected ${rule.category} \`${rootPkg}\`: ${rule.alternative}`,
      m.index,
      m.index + m[0].length,
      fix
    )
  }
}

function auditPackageManifest(
  diags: AuditDiagnostic[],
  getLineStarts: () => number[],
  filePath: string,
  text: string
): void {
  const pkgKeyRe = /"(@?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)"\s*:\s*"[^"]+"/g
  let m: RegExpExecArray | null
  while ((m = pkgKeyRe.exec(text)) !== null) {
    const rule = JS_FRAMEWORK_MAP[m[1]]
    if (!rule) continue
    pushDiag(
      diags,
      getLineStarts,
      filePath,
      rule.code,
      3,
      `Detected dependency \`${m[1]}\` (${rule.category}): ${rule.alternative}`,
      m.index,
      m.index + m[0].length
    )
  }
}

function buildLineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

function offsetToPosition(lineStarts: number[], offset: number): AuditPosition {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lineStarts[mid] <= offset) lo = mid + 1
    else hi = mid - 1
  }
  const line = Math.max(0, hi)
  return { line, character: Math.max(0, offset - lineStarts[line]) }
}

function makeRange(lineStarts: number[], startOff: number, endOff: number): AuditRange {
  return {
    start: offsetToPosition(lineStarts, startOff),
    end: offsetToPosition(lineStarts, endOff),
  }
}

/**
 * Counts top-level comma-separated arguments inside `fnCall(...)` starting at `openParenIdx`.
 * Respects nested parens, brackets, braces, and string quotes in O(callLen) with zero regex backtracking.
 */
function scanCallEndAndArgCount(text: string, openParenIdx: number): { closeIdx: number; args: number } {
  let depthParen = 0
  let depthBrace = 0
  let depthBracket = 0
  let quote = 0
  let hasTokens = false
  let commas = 0
  const maxScan = Math.min(text.length, openParenIdx + 2048)

  for (let i = openParenIdx; i < maxScan; i++) {
    const c = text.charCodeAt(i)
    if (quote !== 0) {
      if (c === 92) {
        i++
        continue
      }
      if (c === quote) quote = 0
      continue
    }
    if (c === 34 || c === 39 || c === 96) {
      quote = c
      hasTokens = true
      continue
    }
    if (c === 40) {
      depthParen++
      continue
    }
    if (c === 41) {
      depthParen--
      if (depthParen === 0) {
        return { closeIdx: i + 1, args: hasTokens ? commas + 1 : 0 }
      }
      continue
    }
    if (c === 123) depthBrace++
    else if (c === 125 && depthBrace > 0) depthBrace--
    else if (c === 91) depthBracket++
    else if (c === 93 && depthBracket > 0) depthBracket--
    else if (c === 44 && depthParen === 1 && depthBrace === 0 && depthBracket === 0) {
      commas++
    } else if (c > 32) {
      hasTokens = true
    }
  }
  return { closeIdx: openParenIdx + 1, args: -1 }
}

function findAllOccurrences(text: string, needle: string): number[] {
  const out: number[] = []
  let idx = 0
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    out.push(idx)
    idx += needle.length
  }
  return out
}

function pushDiag(
  diags: AuditDiagnostic[],
  getLineStarts: () => number[],
  filePath: string,
  code: string,
  severity: AuditSeverity,
  message: string,
  startOff: number,
  endOff: number,
  fix?: AuditFix
): void {
  diags.push({
    code,
    severity,
    message,
    filePath,
    range: makeRange(getLineStarts(), startOff, endOff),
    fix,
  })
}

// --------------------------------------------------------------------------
// Custom Stealify Rules Discovery & Execution Engine (.stealify-rules)
// --------------------------------------------------------------------------

const RULE_FILE_EXTS = new Set(['.json', '.mjs', '.js', '.cjs', '.ts', '.mts'])
const RULE_DIR_NAME = '.stealify-rules'

const ruleFileCache = new Map<
  string,
  { mtimeMs: number; rules: CustomStealifyRule[]; ruleOverrides: Record<string, AuditSeverity | 'off'> }
>()
const dirDiscoveredFilesCache = new Map<string, { timestamp: number; files: string[] }>()

export function clearStealifyRulesCache(): void {
  ruleFileCache.clear()
  dirDiscoveredFilesCache.clear()
}

export function isHostBoundaryFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase()
  const base = path.basename(norm)
  if (
    base.endsWith('.host.mts') ||
    base.endsWith('.host.ts') ||
    base.endsWith('.host.mjs') ||
    base.endsWith('.host.js') ||
    base === 'maintenance.mts' ||
    base === 'maintenance.ts' ||
    base.endsWith('.test.mts') ||
    base.endsWith('.test.ts') ||
    base === 'node-shim.mts'
  ) {
    return true
  }
  if (
    norm.includes('/e2e/') ||
    norm.startsWith('e2e/') ||
    norm.includes('/.project-rules/') ||
    norm.startsWith('.project-rules/') ||
    norm.includes('/projections/') ||
    norm.startsWith('projections/') ||
    norm.includes('/packages/@awesome-os/bin-shim/') ||
    norm.startsWith('packages/@awesome-os/bin-shim/')
  ) {
    return true
  }
  return false
}

export function normalizeSeverity(sev?: CustomRuleSeverityInput): AuditSeverity {
  if (sev === 1 || sev === 'error') return 1
  if (sev === 2 || sev === 'warn' || sev === 'warning') return 2
  if (sev === 3 || sev === 'info') return 3
  if (sev === 4 || sev === 'hint') return 4
  return 2
}

function matchesGlobOrExt(filePath: string, pattern: string): boolean {
  const norm = filePath.replace(/\\/g, '/')
  const base = path.basename(filePath)
  if (pattern === '*' || pattern === '*.*') return true
  if (pattern.startsWith('.')) return norm.toLowerCase().endsWith(pattern.toLowerCase())
  if (pattern.startsWith('*.')) return base.toLowerCase().endsWith(pattern.slice(1).toLowerCase())
  if (pattern.includes('*')) {
    const regexPattern =
      '^' +
      pattern
        .replace(/\\/g, '/')
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*') +
      '$'
    try {
      return new RegExp(regexPattern, 'i').test(norm) || new RegExp(regexPattern, 'i').test(base)
    } catch {
      return false
    }
  }
  return norm.toLowerCase().endsWith(pattern.toLowerCase()) || base.toLowerCase() === pattern.toLowerCase()
}

export function fileMatchesRuleFilter(
  filePath: string,
  files?: string[] | RegExp | string,
  exclude?: string[] | RegExp | string
): boolean {
  if (exclude) {
    if (typeof exclude === 'string') {
      if (matchesGlobOrExt(filePath, exclude)) return false
    } else if (Array.isArray(exclude)) {
      if (exclude.some((p) => matchesGlobOrExt(filePath, p))) return false
    } else if (exclude instanceof RegExp) {
      if (exclude.test(filePath)) return false
    }
  }
  if (!files) return true
  if (typeof files === 'string') return matchesGlobOrExt(filePath, files)
  if (Array.isArray(files)) return files.some((p) => matchesGlobOrExt(filePath, p))
  if (files instanceof RegExp) return files.test(filePath)
  return true
}

export function findStealifyRuleFiles(targetPath: string, rootDir?: string): string[] {
  let currentDir = ''
  try {
    currentDir = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()
      ? path.resolve(targetPath)
      : path.dirname(path.resolve(targetPath))
  } catch {
    currentDir = path.dirname(path.resolve(targetPath))
  }

  const searchDirs: string[] = []
  const resolvedRoot = rootDir ? path.resolve(rootDir).toLowerCase() : null

  while (true) {
    searchDirs.push(currentDir)
    if (resolvedRoot && currentDir.toLowerCase() === resolvedRoot) break
    const parent = path.dirname(currentDir)
    if (parent === currentDir) break // reached root (e.g. C:\ or /)
    currentDir = parent
  }

  // searchDirs has [childDir, parentDir, ... rootDir]
  // Return files from root down to child directory so child overrides parent rules
  searchDirs.reverse()

  const resultFiles: string[] = []

  for (const dir of searchDirs) {
    const cached = dirDiscoveredFilesCache.get(dir)
    const now = Date.now()
    if (cached && now - cached.timestamp < 1500) {
      resultFiles.push(...cached.files)
      continue
    }

    const dirFiles: string[] = []

    // 1. Check directory .stealify-rules/
    const rulesDirPath = path.join(dir, RULE_DIR_NAME)
    if (fs.existsSync(rulesDirPath)) {
      try {
        const st = fs.statSync(rulesDirPath)
        if (st.isDirectory()) {
          const entries = fs.readdirSync(rulesDirPath, { withFileTypes: true })
          const sortedEntries = entries
            .filter((e) => e.isFile() && RULE_FILE_EXTS.has(path.extname(e.name).toLowerCase()))
            .map((e) => path.join(rulesDirPath, e.name))
            .sort()
          dirFiles.push(...sortedEntries)
        } else if (st.isFile()) {
          dirFiles.push(rulesDirPath)
        }
      } catch {}
    }

    // 2. Check candidate rule files in dir
    const candidates = [
      path.join(dir, '.stealify-rules.json'),
      path.join(dir, '.stealify-rules.mjs'),
      path.join(dir, '.stealify-rules.js'),
      path.join(dir, '.stealify-rules.cjs'),
      path.join(dir, '.stealify-rules.mts'),
      path.join(dir, '.stealify-rules.ts'),
    ]
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        try {
          if (fs.statSync(cand).isFile()) {
            dirFiles.push(cand)
          }
        } catch {}
      }
    }

    dirDiscoveredFilesCache.set(dir, { timestamp: now, files: dirFiles })
    resultFiles.push(...dirFiles)
  }

  return resultFiles
}

function parseRulesData(data: any, sourceFile: string): CustomStealifyRule[] {
  let list: any[] = []
  if (Array.isArray(data)) {
    list = data
  } else if (data && Array.isArray(data.rules)) {
    list = data.rules
  } else if (data && typeof data === 'object') {
    list = [data]
  }

  const parsed: CustomStealifyRule[] = []
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!item || typeof item !== 'object') continue
    const id =
      typeof item.id === 'string'
        ? item.id
        : `CUSTOM_${path.basename(sourceFile, path.extname(sourceFile))}_${i + 1}`
    let pattern = item.pattern
    if (typeof pattern === 'string' && pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      try {
        const lastSlash = pattern.lastIndexOf('/')
        const body = pattern.slice(1, lastSlash)
        const flags = pattern.slice(lastSlash + 1)
        pattern = new RegExp(body, flags)
      } catch {}
    }

    parsed.push({
      id,
      severity: item.severity,
      message: item.message || `Custom rule ${id} violation`,
      pattern,
      files: item.files,
      exclude: item.exclude,
      fix: item.fix,
      fixTitle: item.fixTitle,
      inspect: typeof item.inspect === 'function' ? item.inspect : undefined,
    })
  }
  return parsed
}

function parseRuleOverrides(data: any): Record<string, AuditSeverity | 'off'> {
  const overrides: Record<string, AuditSeverity | 'off'> = {}
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.ruleOverrides || typeof data.ruleOverrides !== 'object') {
    return overrides
  }
  for (const [code, val] of Object.entries(data.ruleOverrides)) {
    if (val === 'off' || val === false || val === 0) {
      overrides[code] = 'off'
    } else if (val === 1 || val === 2 || val === 3 || val === 4 || val === 'error' || val === 'warn' || val === 'warning' || val === 'info' || val === 'hint') {
      overrides[code] = normalizeSeverity(val)
    }
  }
  return overrides
}

function loadStealifyRuleEntry(rulePath: string): {
  rules: CustomStealifyRule[]
  ruleOverrides: Record<string, AuditSeverity | 'off'>
} {
  if (!fs.existsSync(rulePath)) return { rules: [], ruleOverrides: {} }
  try {
    const st = fs.statSync(rulePath)
    const cached = ruleFileCache.get(rulePath)
    if (cached && cached.mtimeMs === st.mtimeMs) {
      return { rules: cached.rules, ruleOverrides: cached.ruleOverrides }
    }

    const content = fs.readFileSync(rulePath, 'utf8')
    let parsed: any
    const ext = path.extname(rulePath).toLowerCase()

    if (
      ext === '.json' ||
      (!ext && (content.trimStart().startsWith('{') || content.trimStart().startsWith('[')))
    ) {
      parsed = JSON.parse(content)
    } else {
      try {
        let code = content
        if (code.includes('export default')) {
          code = code.replace(/(?:^|\n)\s*export\s+default\s+/g, '\nreturn ')
        } else if (code.includes('export const rules')) {
          code = code.replace(/(?:^|\n)\s*export\s+const\s+rules\s*=\s*/g, '\nreturn ')
        }
        const fn = new Function('module', 'exports', 'require', '__dirname', '__filename', code)
        const mod: any = { exports: {} }
        const ret = fn(mod, mod.exports, () => ({}), path.dirname(rulePath), rulePath)
        parsed = ret ?? mod.exports
      } catch {
        try {
          parsed = JSON.parse(content)
        } catch {
          parsed = []
        }
      }
    }

    const rules = parseRulesData(parsed, rulePath)
    const ruleOverrides = parseRuleOverrides(parsed)
    ruleFileCache.set(rulePath, { mtimeMs: st.mtimeMs, rules, ruleOverrides })
    return { rules, ruleOverrides }
  } catch {
    return { rules: [], ruleOverrides: {} }
  }
}

export function loadStealifyRulesFromPath(rulePath: string): CustomStealifyRule[] {
  return loadStealifyRuleEntry(rulePath).rules
}

export function getStealifyRuleOverridesForFile(
  filePath: string,
  rootDir?: string
): Record<string, AuditSeverity | 'off'> {
  const ruleFiles = findStealifyRuleFiles(filePath, rootDir)
  const merged: Record<string, AuditSeverity | 'off'> = {}
  for (const rf of ruleFiles) {
    const { ruleOverrides } = loadStealifyRuleEntry(rf)
    for (const [k, v] of Object.entries(ruleOverrides)) {
      merged[k] = v
    }
  }
  return merged
}

export function getStealifyRulesForFile(filePath: string, rootDir?: string): CustomStealifyRule[] {
  const ruleFiles = findStealifyRuleFiles(filePath, rootDir)
  if (ruleFiles.length === 0) return []

  const ruleMap = new Map<string, CustomStealifyRule>()
  for (const rf of ruleFiles) {
    const loaded = loadStealifyRulesFromPath(rf)
    for (const r of loaded) {
      ruleMap.set(r.id, r) // closer files override earlier ones with same id
    }
  }
  return Array.from(ruleMap.values())
}

export function hasCustomRulesForPath(filePath: string, rootDir?: string): boolean {
  return findStealifyRuleFiles(filePath, rootDir).length > 0
}

export function evaluateCustomRules(
  filePath: string,
  text: string,
  rules: readonly CustomStealifyRule[],
  getLineStarts: () => number[]
): AuditDiagnostic[] {
  const diags: AuditDiagnostic[] = []
  let linesCache: string[] | null = null
  const getLines = () => {
    if (!linesCache) linesCache = text.split(/\r?\n/)
    return linesCache
  }

  for (const rule of rules) {
    if (!fileMatchesRuleFilter(filePath, rule.files, rule.exclude)) continue

    const severity = normalizeSeverity(rule.severity)
    const ctx: CustomRuleContext = {
      filePath,
      text,
      get lines() {
        return getLines()
      },
      get lineStarts() {
        return getLineStarts()
      },
    }

    // 1. Programmatic inspect()
    if (rule.inspect) {
      try {
        const matches = rule.inspect(ctx)
        if (Array.isArray(matches)) {
          const lineStarts = getLineStarts()
          for (const m of matches) {
            const startLineOffset = lineStarts[m.line] ?? 0
            const startOff = startLineOffset + m.character
            const len = m.length ?? 1
            const endOff = startOff + len

            let fix: AuditFix | undefined
            if (m.fix) {
              const fStart = m.fix.startOffset ?? startOff
              const fEnd = m.fix.endOffset ?? endOff
              fix = {
                title: m.fix.title || rule.fixTitle || `Fix ${rule.id}`,
                startOffset: fStart,
                endOffset: fEnd,
                replacement: m.fix.replacement,
              }
            }

            diags.push({
              code: rule.id,
              severity: m.severity ? normalizeSeverity(m.severity) : severity,
              message:
                m.message ||
                (typeof rule.message === 'function' ? rule.message(null, ctx) : rule.message),
              filePath,
              range: makeRange(lineStarts, startOff, endOff),
              fix,
            })
          }
        }
      } catch {}
    }

    // 2. Pattern matching
    if (rule.pattern) {
      if (typeof rule.pattern === 'string') {
        const pat = rule.pattern
        if (!text.includes(pat)) continue
        for (const idx of findAllOccurrences(text, pat)) {
          const startOff = idx
          const endOff = idx + pat.length
          const msg = typeof rule.message === 'function' ? rule.message(null, ctx) : rule.message

          let fix: AuditFix | undefined
          if (rule.fix) {
            const repl = typeof rule.fix === 'string' ? rule.fix : rule.fix(null, ctx)
            if (typeof repl === 'string') {
              fix = {
                title: rule.fixTitle || `Replace with \`${repl}\``,
                startOffset: startOff,
                endOffset: endOff,
                replacement: repl,
              }
            } else if (repl && typeof repl === 'object') {
              fix = {
                title: repl.title || rule.fixTitle || `Fix ${rule.id}`,
                startOffset: repl.startOffset ?? startOff,
                endOffset: repl.endOffset ?? endOff,
                replacement: repl.replacement,
              }
            }
          }

          diags.push({
            code: rule.id,
            severity,
            message: msg,
            filePath,
            range: makeRange(getLineStarts(), startOff, endOff),
            fix,
          })
        }
      } else if (rule.pattern instanceof RegExp) {
        const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g'
        const re = new RegExp(rule.pattern.source, flags)
        let m: RegExpExecArray | null
        while ((m = re.exec(text)) !== null) {
          const startOff = m.index
          const endOff = m.index + m[0].length
          const matchCopy = m
          const msg = typeof rule.message === 'function' ? rule.message(matchCopy, ctx) : rule.message

          let fix: AuditFix | undefined
          if (rule.fix) {
            if (typeof rule.fix === 'string') {
              let repl = rule.fix
              if (m.length > 1) {
                for (let g = 1; g < m.length; g++) {
                  repl = repl.split(`$${g}`).join(m[g] ?? '')
                }
              }
              fix = {
                title: rule.fixTitle || `Fix ${rule.id}`,
                startOffset: startOff,
                endOffset: endOff,
                replacement: repl,
              }
            } else {
              const res = rule.fix(matchCopy, ctx)
              if (typeof res === 'string') {
                fix = {
                  title: rule.fixTitle || `Fix ${rule.id}`,
                  startOffset: startOff,
                  endOffset: endOff,
                  replacement: res,
                }
              } else if (res && typeof res === 'object') {
                fix = {
                  title: res.title || rule.fixTitle || `Fix ${rule.id}`,
                  startOffset: res.startOffset ?? startOff,
                  endOffset: res.endOffset ?? endOff,
                  replacement: res.replacement,
                }
              }
            }
          }

          diags.push({
            code: rule.id,
            severity,
            message: msg,
            filePath,
            range: makeRange(getLineStarts(), startOff, endOff),
            fix,
          })

          if (m[0].length === 0) re.lastIndex++
        }
      }
    }
  }

  return diags
}

function maskHtmlNonProseBlocks(html: string): string {
  // Replace <script>, <style>, <code>, and <pre> bodies with spaces (preserving newlines & offsets)
  return html.replace(/<(script|style|code|pre)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) =>
    m.replace(/[^\r\n]/g, ' ')
  )
}

function maskHtmlTableScanNoise(html: string): string {
  // Replace HTML comments, <script>, and <style> blocks with spaces while preserving offsets & newlines
  return html
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\r\n]/g, ' '))
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\r\n]/g, ' '))
}

function hasHtmlTableWrapCss(html: string): boolean {
  const wrapPropRe = /\b(?:table-layout|overflow-wrap|word-break)\s*:/i
  const styleBlockRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
  let sm: RegExpExecArray | null
  while ((sm = styleBlockRe.exec(html)) !== null) {
    if (wrapPropRe.test(sm[1])) return true
  }
  const inlineStyleRe = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
  let im: RegExpExecArray | null
  while ((im = inlineStyleRe.exec(html)) !== null) {
    if (wrapPropRe.test(im[1] ?? im[2] ?? '')) return true
  }
  return false
}

function parsePositiveSpanAttr(attrs: string, name: 'colspan' | 'rowspan'): number {
  const re = name === 'colspan'
    ? /\bcolspan\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i
    : /\browspan\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i
  const m = re.exec(attrs)
  if (!m) return 1
  const n = Number.parseInt(m[1] ?? m[2] ?? m[3] ?? '1', 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

function auditHtmlTables(
  diags: AuditDiagnostic[],
  getLineStarts: () => number[],
  filePath: string,
  text: string
): void {
  if (!/<table\b/i.test(text)) return

  const clean = maskHtmlTableScanNoise(text)
  const hasWrapCss = hasHtmlTableWrapCss(text)

  // Find each <table>...</table> block (handling nesting by pairing open/close tags)
  const tableTagRe = /<(\/)?table\b[^>]*>/gi
  const tableStack: Array<{ start: number; openEnd: number }> = []
  const tables: Array<{ start: number; openEnd: number; end: number }> = []
  let tm: RegExpExecArray | null
  while ((tm = tableTagRe.exec(clean)) !== null) {
    const isClose = tm[1] === '/'
    if (!isClose) {
      tableStack.push({ start: tm.index, openEnd: tm.index + tm[0].length })
    } else if (tableStack.length > 0) {
      const open = tableStack.pop()!
      tables.push({ start: open.start, openEnd: open.openEnd, end: tm.index + tm[0].length })
    }
  }

  for (const tbl of tables) {
    const body = clean.slice(tbl.openEnd, tbl.end)

    // B8G018 warning: <table> containing <code> without table-layout / overflow-wrap / word-break CSS
    if (!hasWrapCss && /<code\b/i.test(body)) {
      pushDiag(
        diags,
        getLineStarts,
        filePath,
        'B8G018',
        2,
        'HTML `<table>` contains `<code>` elements, but document CSS lacks `table-layout`, `overflow-wrap`, or `word-break` (`html-table-alignment`). Add `table-layout: fixed` and `overflow-wrap: break-word` to prevent horizontal column overflow.',
        tbl.start,
        tbl.openEnd
      )
    }

    // Mask any nested inner <table>...</table> so outer row counts aren't polluted by nested tables
    const flatBody = body.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (m) => m.replace(/[^\r\n]/g, ' '))
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
    const cellRe = /<t[dh]\b([^>]*)>/gi

    const activeRowspans: number[] = []
    let expectedCols: number | null = null
    let rm: RegExpExecArray | null

    while ((rm = trRe.exec(flatBody)) !== null) {
      const trAbsStart = tbl.openEnd + rm.index
      const openTagClose = rm[0].indexOf('>')
      const trAbsOpenEnd = trAbsStart + (openTagClose === -1 ? rm[0].length : openTagClose + 1)
      const trInner = rm[1]

      let col = 0
      const advanceOccupied = (): void => {
        while (col < activeRowspans.length && activeRowspans[col] > 0) {
          col++
        }
      }

      const newlyAdded = new Set<number>()
      cellRe.lastIndex = 0
      let cm: RegExpExecArray | null
      while ((cm = cellRe.exec(trInner)) !== null) {
        advanceOccupied()
        const attrs = cm[1] ?? ''
        const colspan = parsePositiveSpanAttr(attrs, 'colspan')
        const rowspan = parsePositiveSpanAttr(attrs, 'rowspan')
        if (rowspan > 1) {
          for (let c = 0; c < colspan; c++) {
            const idx = col + c
            activeRowspans[idx] = Math.max(activeRowspans[idx] ?? 0, rowspan - 1)
            newlyAdded.add(idx)
          }
        }
        col += colspan
      }

      // Compute effective column count including trailing occupied rowspan columns
      let effectiveCols = col
      for (let k = activeRowspans.length - 1; k >= 0; k--) {
        if (activeRowspans[k] > 0) {
          effectiveCols = Math.max(effectiveCols, k + 1)
          break
        }
      }

      // Decrement pre-existing active rowspans for subsequent rows
      for (let k = 0; k < activeRowspans.length; k++) {
        if (!newlyAdded.has(k) && activeRowspans[k] > 0) {
          activeRowspans[k]--
        }
      }

      if (expectedCols === null) {
        expectedCols = effectiveCols
      } else if (effectiveCols !== expectedCols) {
        pushDiag(
          diags,
          getLineStarts,
          filePath,
          'B8G018',
          1,
          `HTML table row has ${effectiveCols} effective column(s), expected ${expectedCols} to match row 1 (\`html-table-alignment\`). Check missing \`<td>\`/\`<th>\` cells or \`colspan\`/\`rowspan\` values.`,
          trAbsStart,
          trAbsOpenEnd
        )
      }
    }
  }
}

function isEscapedAt(str: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && str.charCodeAt(i) === 92; i--) {
    backslashes++
  }
  return (backslashes & 1) === 1
}

function splitUnescapedPipes(trimmedLine: string): string[] {
  let s = trimmedLine
  if (s.startsWith('|')) {
    s = s.slice(1)
  }
  if (s.endsWith('|') && !isEscapedAt(s, s.length - 1)) {
    s = s.slice(0, -1)
  }
  const cells: string[] = []
  let start = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 124 && !isEscapedAt(s, i)) {
      cells.push(s.slice(start, i))
      start = i + 1
    }
  }
  cells.push(s.slice(start))
  return cells
}

function hasUnescapedPipe(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) === 124 && !isEscapedAt(line, i)) return true
  }
  return false
}

function isMarkdownTableDelimiterRow(trimmedLine: string): boolean {
  if (!trimmedLine.includes('-') || !hasUnescapedPipe(trimmedLine)) return false
  const cells = splitUnescapedPipes(trimmedLine)
  if (cells.length === 0) return false
  for (let i = 0; i < cells.length; i++) {
    if (!/^:?-+:?$/.test(cells[i].trim())) return false
  }
  return true
}

function auditMarkdownOutput(
  diags: AuditDiagnostic[],
  getLineStarts: () => number[],
  filePath: string,
  text: string
): void {
  if (!text.includes('|')) return

  const lines = text.split(/\r?\n/)
  const lineStarts = getLineStarts()

  let fenceChar = ''
  let fenceLen = 0
  let i = 0

  while (i < lines.length) {
    const trimmed = lines[i].trim()

    // Track fenced code blocks (``` or ~~~)
    if (fenceChar) {
      const closeRe = fenceChar === '`' ? /^(`{3,})\s*$/ : /^(~{3,})\s*$/
      const cm = closeRe.exec(trimmed)
      if (cm && cm[1].length >= fenceLen) {
        fenceChar = ''
        fenceLen = 0
      }
      i++
      continue
    }

    const openFence = /^(`{3,}|~{3,})/.exec(trimmed)
    if (openFence) {
      fenceChar = openFence[1][0]
      fenceLen = openFence[1].length
      i++
      continue
    }

    // Detect start of a GFM pipe table: header row with unescaped `|` followed by delimiter row
    if (
      i + 1 < lines.length &&
      trimmed.length > 0 &&
      hasUnescapedPipe(trimmed) &&
      isMarkdownTableDelimiterRow(lines[i + 1].trim())
    ) {
      const expectedCols = splitUnescapedPipes(trimmed).length

      // Validate delimiter row and all contiguous body rows
      let j = i + 1
      while (j < lines.length) {
        const rowRaw = lines[j]
        const rowTrim = rowRaw.trim()
        if (rowTrim.length === 0 || /^(`{3,}|~{3,})/.test(rowTrim) || !hasUnescapedPipe(rowTrim)) {
          break
        }
        const actualCols = splitUnescapedPipes(rowTrim).length
        if (actualCols !== expectedCols) {
          const startOff = lineStarts[j] ?? 0
          const endOff = startOff + rowRaw.length
          pushDiag(
            diags,
            getLineStarts,
            filePath,
            'B8G019',
            2,
            `Markdown table row (line ${j + 1}) has ${actualCols} column(s), expected ${expectedCols} to match header row (\`markdown-table-alignment\`). Escape literal pipes inside cells (including inside backticks) as \`\\|\`.`,
            startOff,
            endOff
          )
        }
        j++
      }
      i = j
      continue
    }

    i++
  }
}

function auditHtmlOutput(
  diags: AuditDiagnostic[],
  getLineStarts: () => number[],
  filePath: string,
  text: string
): void {
  const masked = maskHtmlNonProseBlocks(text)
  const seenOffsets = new Set<number>()

  // B8G014: Unrendered raw LaTeX leaked into static HTML output
  const patterns: RegExp[] = [
    /\$\$/g,
    /\$(?:[^$\r\n<>]*[\\_^][^$\r\n<>]*)\$/g,
    /\\(?:text|mathcal|mathbb|frac|dfrac|tfrac|big|Big|bigg|left|right|cdot|times|bar|overline|Delta|Sigma|Omega|alpha|beta|gamma|epsilon|lambda|sigma|theta|ll|gg|leq|geq|approx|equiv|sum|prod|int|infty|forall|exists|implies|iff|to|rightarrow)\b/g,
  ]

  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      if (seenOffsets.has(m.index)) continue
      seenOffsets.add(m.index)
      const snippet = m[0].length > 48 ? `${m[0].slice(0, 45)}...` : m[0]
      pushDiag(
        diags,
        getLineStarts,
        filePath,
        'B8G014',
        1,
        `Unrendered raw LaTeX leaked into HTML output (${JSON.stringify(snippet)}). Compile TeX math to static HTML/Unicode at build time so readers never see raw LaTeX syntax.`,
        m.index,
        m.index + m[0].length
      )
    }
  }

  // B8G018: HTML table column alignment & <code> overflow CSS guard
  auditHtmlTables(diags, getLineStarts, filePath, text)
}

const HTML_OPEN_TAG_RE =
  /<(?:!doctype\s+html|html|head|body|main|section|article|header|footer|nav|aside|div|span|p|h[1-6]|ul|ol|li|table|thead|tbody|tr|th|td|form|label|button|a|iframe|canvas|pre|blockquote|figure|figcaption)\b/i
const HTML_CLOSE_TAG_RE =
  /<\/(?:html|head|body|main|section|article|header|footer|nav|aside|div|span|p|h[1-6]|ul|ol|li|table|thead|tbody|tr|th|td|form|label|button|a|iframe|canvas|pre|blockquote|figure|figcaption)\s*>/i

function isPrecededByTagIdentifier(text: string, tickIdx: number): boolean {
  let k = tickIdx - 1
  while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--
  if (k < 0) return false
  const ch = text[k]!
  if (!/[a-zA-Z0-9_$)]/.test(ch)) return false
  // Check that the preceding identifier is not a JS keyword like `return`, `yield`, `await`, `typeof`, `case`, `else`, `throw`, `export`, `default`
  let start = k
  while (start > 0 && /[a-zA-Z0-9_$]/.test(text[start - 1]!)) start--
  const word = text.slice(start, k + 1)
  if (
    word === 'return' ||
    word === 'yield' ||
    word === 'await' ||
    word === 'typeof' ||
    word === 'case' ||
    word === 'else' ||
    word === 'throw' ||
    word === 'export' ||
    word === 'default' ||
    word === 'of' ||
    word === 'in'
  ) {
    return false
  }
  return true
}

function auditUntaggedHtmlTemplates(
  diags: AuditDiagnostic[],
  getLineStarts: () => number[],
  filePath: string,
  text: string
): void {
  if (!text.includes('`') || (!text.includes('</') && !/<!doctype\s+html/i.test(text))) return

  const len = text.length
  const scanRange = (startIdx: number, stopOnCloseBrace: boolean): number => {
    let i = startIdx
    let braceDepth = 0
    while (i < len) {
      const ch = text[i]!
      const next = text[i + 1]

      // Line comment
      if (ch === '/' && next === '/') {
        i += 2
        while (i < len && text[i] !== '\n') i++
        continue
      }
      // Block comment
      if (ch === '/' && next === '*') {
        i += 2
        while (i + 1 < len && !(text[i] === '*' && text[i + 1] === '/')) i++
        i += 2
        continue
      }
      // Single / double quoted string
      if (ch === "'" || ch === '"') {
        const q = ch
        i++
        while (i < len && text[i] !== q) {
          if (text[i] === '\\') i++
          i++
        }
        i++
        continue
      }
      if (stopOnCloseBrace) {
        if (ch === '{') braceDepth++
        else if (ch === '}') {
          if (braceDepth === 0) return i + 1
          braceDepth--
        }
      }
      // Template literal
      if (ch === '`') {
        const tickIdx = i
        const tagged = isPrecededByTagIdentifier(text, tickIdx)
        i++
        let quasi = ''
        while (i < len && text[i] !== '`') {
          if (text[i] === '\\' && i + 1 < len) {
            quasi += text[i]! + text[i + 1]!
            i += 2
            continue
          }
          if (text[i] === '$' && text[i + 1] === '{') {
            quasi += ' '
            i = scanRange(i + 2, true)
            continue
          }
          quasi += text[i]!
          i++
        }
        const closeTick = i
        i++ // consume closing `

        if (!tagged && closeTick < len) {
          const isDoc = /<!doctype\s+html\b/i.test(quasi)
          const isHtmlMarkup = isDoc || (HTML_OPEN_TAG_RE.test(quasi) && HTML_CLOSE_TAG_RE.test(quasi))
          if (isHtmlMarkup) {
            pushDiag(
              diags,
              getLineStarts,
              filePath,
              'B8G015',
              2,
              'Untagged HTML template literal detected. Prefix with `html` (`html`...``) so IDEs, parsers, and `stealify-lint` recognize it as HTML (enabling syntax highlighting, tag checking, and future composable HTML sections).',
              tickIdx,
              Math.min(len, tickIdx + 1),
              {
                title: 'Tag HTML template literal with `html`',
                startOffset: tickIdx,
                endOffset: tickIdx,
                replacement: 'html',
              }
            )
          }
        }
        continue
      }
      i++
    }
    return i
  }

  scanRange(0, false)
}

function maskJsTsComments(text: string): string {
  const len = text.length
  const out: string[] = []
  let i = 0
  while (i < len) {
    const ch = text[i]!
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      out.push(' ', ' ')
      i += 2
      while (i < len && text[i] !== '\n') {
        out.push(text[i] === '\r' ? '\r' : ' ')
        i++
      }
      continue
    }
    if (ch === '/' && next === '*') {
      out.push(' ', ' ')
      i += 2
      while (i < len) {
        if (text[i] === '*' && text[i + 1] === '/') {
          out.push(' ', ' ')
          i += 2
          break
        }
        out.push(text[i] === '\n' || text[i] === '\r' ? text[i]! : ' ')
        i++
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      out.push(ch)
      i++
      while (i < len && text[i] !== q) {
        if (text[i] === '\\' && i + 1 < len) {
          out.push(text[i]!, text[i + 1]!)
          i += 2
          continue
        }
        out.push(text[i]!)
        i++
      }
      if (i < len) {
        out.push(text[i]!)
        i++
      }
      continue
    }
    out.push(ch)
    i++
  }
  return out.join('')
}

export function auditSourceText(
  filePath: string,
  text: string,
  options?: {
    customRules?: CustomStealifyRule[]
    disableCustomRules?: boolean
    rootDir?: string
  }
): AuditDiagnostic[] {
  const baseName = path.basename(filePath).toLowerCase()
  if (
    baseName.endsWith('.d.ts') ||
    baseName.endsWith('.d.mts') ||
    baseName.endsWith('.d.cts') ||
    baseName.endsWith('.min.js') ||
    baseName.endsWith('.min.mjs')
  ) {
    return []
  }

  const ext = path.extname(filePath).toLowerCase()
  const isPkgJson = baseName === 'package.json'
  const isJsTs = JS_TS_EXTS.has(ext)
  const isPy = PY_EXTS.has(ext)
  const isHtml = HTML_EXTS.has(ext)
  const isMd = MD_EXTS.has(ext)
  if (!isJsTs && !isPy && !isPkgJson && !isHtml && !isMd) return []

  const diags: AuditDiagnostic[] = []
  let cachedLineStarts: number[] | null = null
  const getLineStarts = (): number[] => {
    if (!cachedLineStarts) cachedLineStarts = buildLineStarts(text)
    return cachedLineStarts
  }

  const ruleOverrides =
    !options?.disableCustomRules && (options?.rootDir !== undefined || fs.existsSync(filePath))
      ? getStealifyRuleOverridesForFile(filePath, options?.rootDir)
      : {}

  const applyOverrides = (list: AuditDiagnostic[]): AuditDiagnostic[] => {
    if (Object.keys(ruleOverrides).length === 0) return list
    const filtered: AuditDiagnostic[] = []
    for (const d of list) {
      const ov = ruleOverrides[d.code]
      if (ov === 'off') continue
      if (ov !== undefined) filtered.push({ ...d, severity: ov })
      else filtered.push(d)
    }
    return filtered
  }

  // --- Evaluate Custom Stealify Rules (.stealify-rules) ---
  if (!options?.disableCustomRules) {
    const customRules = options?.customRules ?? getStealifyRulesForFile(filePath, options?.rootDir)
    if (customRules.length > 0) {
      diags.push(...evaluateCustomRules(filePath, text, customRules, getLineStarts))
    }
  }

  if (isPkgJson) {
    auditPackageManifest(diags, getLineStarts, filePath, text)
    return applyOverrides(diags)
  }

  if (isHtml) {
    auditHtmlOutput(diags, getLineStarts, filePath, text)
    return applyOverrides(diags)
  }

  if (isMd) {
    auditMarkdownOutput(diags, getLineStarts, filePath, text)
    return applyOverrides(diags)
  }

  if (isPy) {
    auditFrameworkImports(diags, getLineStarts, filePath, text, PY_FRAMEWORK_MAP, true)
    // B8G011: Python os.walk + os.stat or ASGI StaticFiles
    if (text.includes('os.walk(') && text.includes('os.stat(')) {
      const walkRe = /\bos\.walk\s*\(/g
      let m: RegExpExecArray | null
      while ((m = walkRe.exec(text)) !== null) {
        pushDiag(
          diags,
          getLineStarts,
          filePath,
          'B8G011',
          2,
          '`os.walk()` combined with `os.stat()` issues extra stat syscalls (~8.6x slower on Windows). Use `os.scandir()` with `entry.stat(follow_symlinks=False)`.',
          m.index,
          m.index + m[0].length
        )
      }
    }
    if (text.includes('StaticFiles(')) {
      for (const idx of findAllOccurrences(text, 'StaticFiles(')) {
        pushDiag(
          diags,
          getLineStarts,
          filePath,
          'B8G011',
          3,
          '`StaticFiles()` routes static asset serving through Python ASGI dict/threadpool overhead. Consider serving static bundles via aligned `b8g-pack` (`mmap` + `memoryview`).',
          idx,
          idx + 'StaticFiles'.length
        )
      }
    }
    return diags
  }

  auditFrameworkImports(diags, getLineStarts, filePath, text, JS_FRAMEWORK_MAP, false)

  // B8G001: vscode.workspace.findFiles(pattern) without 2nd `exclude` arg
  if (text.includes('findFiles(')) {
    for (const idx of findAllOccurrences(text, 'findFiles(')) {
      const prevCh = idx > 0 ? text.charAt(idx - 1) : ''
      if (prevCh && /[a-zA-Z0-9_$]/.test(prevCh)) continue
      const openIdx = idx + 'findFiles'.length
      const { closeIdx, args } = scanCallEndAndArgCount(text, openIdx)
      if (args === 1) {
        pushDiag(
          diags,
          getLineStarts,
          filePath,
          'B8G001',
          1,
          '`workspace.findFiles(pattern)` omits the 2nd `exclude` parameter, causing VS Code `rg.exe --no-ignore --follow` to walk all `node_modules` & symlinks.',
          idx,
          closeIdx
        )
      }
    }
  }

  // B8G002: config.get('...') || true / !0 boolean trap
  if (text.includes('.get(') && text.includes('||')) {
    const boolTrapRe = /\.get\(([^)]+)\)\s*\|\|\s*(true|!0)\b/g
    let bm: RegExpExecArray | null
    while ((bm = boolTrapRe.exec(text)) !== null) {
      const opOffset = bm.index + bm[0].indexOf('||')
      pushDiag(
        diags,
        getLineStarts,
        filePath,
        'B8G002',
        1,
        '`.get(...) || true` turns user `false` into `true`. Use nullish coalescing (`??`) instead.',
        bm.index,
        bm.index + bm[0].length,
        {
          title: 'Replace `||` with `??`',
          startOffset: opOffset,
          endOffset: opOffset + 2,
          replacement: '??',
        }
      )
    }
  }

  // B8G003: ES #private fields in class declarations (SIMD `#` gate skips most files cleanly)
  if (text.includes('#')) {
    const privateRe = /^[ \t]*(?:readonly\s+|static\s+|async\s+)*(#([a-zA-Z_][a-zA-Z0-9_]*))[ \t]*(?:[:=(])/gm
    let pm: RegExpExecArray | null
    while ((pm = privateRe.exec(text)) !== null) {
      const hashIdx = pm.index + pm[0].indexOf('#')
      if (text.slice(pm.index, hashIdx).includes('//')) continue
      pushDiag(
        diags,
        getLineStarts,
        filePath,
        'B8G003',
        2,
        `ES private field \`${pm[1]}\` adds V8 WeakMap/brand checks on hot paths. Prefer constructor-initialized \`private _${pm[2]}\` slots.`,
        hashIdx,
        hashIdx + pm[1].length
      )
    }
  }

  // B8G004: Object.assign(this, ...) hidden-class polymorphism
  if (text.includes('Object.assign(this,')) {
    for (const idx of findAllOccurrences(text, 'Object.assign(this,')) {
      pushDiag(
        diags,
        getLineStarts,
        filePath,
        'B8G004',
        2,
        '`Object.assign(this, ...)` mutates V8 object shapes dynamically. Assign fixed constructor fields directly for monomorphic inline caches.',
        idx,
        idx + 'Object.assign(this,'.length
      )
    }
  }

  // B8G005 & B8G006: fs.readdir / statSync directory-walk traps (gated on `readdir`)
  if (text.includes('readdir')) {
    if (text.includes('statSync(') || text.includes('lstatSync(')) {
      const statRe = /\b(?:fs\.)?(statSync|lstatSync)\s*\(/g
      let sm: RegExpExecArray | null
      while ((sm = statRe.exec(text)) !== null) {
        pushDiag(
          diags,
          getLineStarts,
          filePath,
          'B8G005',
          2,
          `\`${sm[1]}()\` alongside \`readdir\` issues extra per-file kernel open/stat syscalls (NTFS \`FindNextFile\` metadata was discarded by libuv). Batch or use \`b8g-pack\`.`,
          sm.index,
          sm.index + sm[0].length
        )
      }
    }

    if (text.includes('withFileTypes') && text.includes('recursive')) {
      const readdirRe = /\breaddir(?:Sync)?\s*\(/g
      let rm: RegExpExecArray | null
      while ((rm = readdirRe.exec(text)) !== null) {
        const openIdx = rm.index + rm[0].length - 1
        const { closeIdx } = scanCallEndAndArgCount(text, openIdx)
        const callSlice = text.slice(rm.index, closeIdx)
        if (callSlice.includes('recursive') && callSlice.includes('true') && callSlice.includes('withFileTypes')) {
          pushDiag(
            diags,
            getLineStarts,
            filePath,
            'B8G006',
            2,
            '`readdir({ recursive: true, withFileTypes: true })` allocates JS `Dirent` objects for every unpruned `node_modules`/`.git` entry (~2x heap). Prune via `opendir` stack or pack with `b8g-pack`.',
            rm.index,
            closeIdx
          )
        }
      }
    }
  }

  // B8G007 & B8G008: new Response(...) SAB / dummy formData traps (gated on `new Response(`)
  if (text.includes('new Response(')) {
    if (text.includes('.slab') || text.includes('.u8') || text.includes('.bytes') || text.includes('sab')) {
      const respRe = /\bnew\s+Response\s*\(\s*([a-zA-Z0-9_$.]+\.(?:slab|u8|bytes)|sab[A-Za-z0-9_]*)\b/g
      let rsm: RegExpExecArray | null
      while ((rsm = respRe.exec(text)) !== null) {
        if (!text.slice(Math.max(0, rsm.index - 220), rsm.index).includes('instanceof SharedArrayBuffer')) {
          pushDiag(
            diags,
            getLineStarts,
            filePath,
            'B8G007',
            2,
            `Passing \`${rsm[1]}\` directly into \`new Response()\` coerces \`SharedArrayBuffer\` views into CSV strings in Fetch/Undici. Guard with \`instanceof SharedArrayBuffer ? new Uint8Array(view) : view\`.`,
            rsm.index,
            rsm.index + rsm[0].length
          )
        }
      }
    }

    if (text.includes('.formData()')) {
      for (const idx of findAllOccurrences(text, '.formData()')) {
        const ctx = text.slice(Math.max(0, idx - 60), idx)
        if (ctx.includes('new Response(')) {
          pushDiag(
            diags,
            getLineStarts,
            filePath,
            'B8G008',
            3,
            'Wrapping request text inside `new Response(...).formData()` allocates Web Streams wrappers on every form request. Parse directly via linear buffer/decode.',
            idx - 12,
            idx + '.formData()'.length
          )
        }
      }
    }
  }

  // B8G009: Electron registerSchemesAsPrivileged missing allowServiceWorkers or codeCache
  if (text.includes('registerSchemesAsPrivileged(')) {
    for (const idx of findAllOccurrences(text, 'registerSchemesAsPrivileged(')) {
      const { closeIdx } = scanCallEndAndArgCount(text, idx + 'registerSchemesAsPrivileged'.length)
      const slice = text.slice(idx, Math.min(text.length, closeIdx))
      if (!slice.includes('allowServiceWorkers') || !slice.includes('codeCache')) {
        pushDiag(
          diags,
          getLineStarts,
          filePath,
          'B8G009',
          3,
          'Electron `registerSchemesAsPrivileged` is missing `allowServiceWorkers: true` or `codeCache: true`, limiting SW `Cache API` packaging and V8 bytecode caching.',
          idx,
          idx + 'registerSchemesAsPrivileged'.length
        )
      }
    }
  }

  // B8G010: zlib decompressSync(*.subarray(...)) Deno byteOffset hazard
  if (text.includes('DecompressSync') && text.includes('.subarray(')) {
    const zlibRe = /\b(?:brotliDecompressSync|gunzipSync|zstdDecompressSync)\s*\([^)]*?\.subarray\s*\(/g
    let zm: RegExpExecArray | null
    while ((zm = zlibRe.exec(text)) !== null) {
      const subOff = zm.index + zm[0].lastIndexOf('.subarray')
      pushDiag(
        diags,
        getLineStarts,
        filePath,
        'B8G010',
        2,
        'Passing `.subarray(...)` with non-zero `byteOffset` into `node:zlib.*DecompressSync` throws `InvalidData` on Deno (`ext:deno_node/_brotli.js`). Use `.slice(...)`.',
        subOff,
        subOff + '.subarray'.length,
        {
          title: 'Replace `.subarray(` with `.slice(`',
          startOffset: subOff,
          endOffset: subOff + '.subarray'.length,
          replacement: '.slice',
        }
      )
    }
  }

  // B8G012 & B8G013: Enforce Zero Ambient Authority & Capability Injection on portable modules
  if (!isHostBoundaryFile(filePath)) {
    const coupling = scanHostCoupling(text)
    for (const g of coupling.globals) {
      const fix: AuditFix | undefined = g.byteLengthFix
        ? {
            title: 'Replace `Buffer.byteLength(...)` with Web-standard `new TextEncoder().encode(...).byteLength`',
            startOffset: g.byteLengthFix.startOffset,
            endOffset: g.byteLengthFix.endOffset,
            replacement: g.byteLengthFix.replacement,
          }
        : undefined
      pushDiag(
        diags,
        getLineStarts,
        filePath,
        'B8G012',
        1,
        `Ambient host global \`${g.name}\` is prohibited (couples code to \`@types/node\` & violates Zero Ambient Authority). Inject \`${g.capType}\` via \`(caps) => ...\` or run \`stealify-lint <file> --refactor-iife --emit\`.`,
        g.startOffset,
        g.endOffset,
        fix
      )
    }

    for (const imp of coupling.imports) {
      pushDiag(
        diags,
        getLineStarts,
        filePath,
        'B8G013',
        1,
        `Direct host import \`${imp.spec}\` is prohibited in portable modules. Inject \`${imp.capType}\` via \`(caps: { ${imp.capKey}: ${imp.capType} }) => ...\` or run \`stealify-lint <file> --refactor-iife --emit\`.`,
        imp.startOffset,
        imp.endOffset
      )
    }

    for (const req of coupling.requires) {
      pushDiag(
        diags,
        getLineStarts,
        filePath,
        'B8G013',
        1,
        `Direct host require \`${req.spec}\` is prohibited in portable modules. Inject \`${req.capType}\` via \`(caps: { ${req.capKey}: ${req.capType} }) => ...\` or run \`stealify-lint <file> --refactor-iife --emit\`.`,
        req.startOffset,
        req.endOffset
      )
    }
  }

  // B8G015: Untagged HTML template literals should use `html\`...\``
  auditUntaggedHtmlTemplates(diags, getLineStarts, filePath, text)

  // B8G016: Ban local HTTP/HTTPS servers for OS/VM/daemon IPC (use Named Pipes / Unix Sockets / CDP Pipe)
  const normPath = filePath.replace(/\\/g, '/')
  const isTestFile = /\.test\.[cm]?[jt]sx?$/i.test(normPath)
  const isExplicitWebPreview = /\/site\/preview-site\.host\.mts$/i.test(normPath)
  if (!isTestFile && !isExplicitWebPreview && !text.includes('b8g-allow-http-ipc')) {
    const httpSrvRe = /\b(?:https?\.createServer)\s*\(/g
    let hm: RegExpExecArray | null
    while ((hm = httpSrvRe.exec(text)) !== null) {
      pushDiag(
        diags,
        getLineStarts,
        filePath,
        'B8G016',
        2,
        'Avoid decoupled local `http(s).createServer()` for OS/daemon IPC (causes EADDRINUSE & ambient loopback exposure). Use OS Named Pipes (`\\\\.\\pipe\\b8g-*` / Unix sockets), CDP `--remote-debugging-pipe` + `Runtime.addBinding`, or add `// b8g-allow-http-ipc` for explicit external web/metrics endpoints.',
        hm.index,
        hm.index + hm[0].length
      )
    }
  }

  // B8G017 (declarative-section-context): Advisory info on imperative sections/*/index.mts & intersections/*/index.mts
  if (
    DECLARATIVE_SECTION_ENTRY_RE.test(normPath) &&
    !text.includes('defineSection(') &&
    !text.includes('defineIntersection(') &&
    !text.includes('intersect(') &&
    !text.includes('ExecutionContext') &&
    !text.includes('checkAdmissibility(') &&
    !text.includes('b8g-allow-imperative-module')
  ) {
    const firstNl = text.indexOf('\n')
    const firstLineEnd = firstNl === -1 ? text.length : firstNl
    pushDiag(
      diags,
      getLineStarts,
      filePath,
      'B8G017',
      3,
      'Imperative TypeScript entrypoint without a declarative StealifyLang `defineSection`/`intersect`/`ExecutionContext` contract (`declarative-section-context`). Add a declarative contract (`defineSection(`, `defineIntersection(`, `intersect(`, `ExecutionContext`, or `checkAdmissibility(`) or annotate `// b8g-allow-imperative-module`.',
      0,
      firstLineEnd
    )
  }

  // B8G020 (streams-first-intersection): Advisory info when intersections/*/index.mts uses EventEmitter without Web Streams
  if (
    INTERSECTION_ENTRY_RE.test(normPath) &&
    !isTestFile &&
    !/^cli/i.test(baseName) &&
    text.includes('EventEmitter') &&
    !text.includes('TransformStream') &&
    !text.includes('ReadableStream') &&
    !text.includes('WritableStream') &&
    !text.includes('createPersonaTee') &&
    !text.includes('composeIntersectionStreams') &&
    !text.includes('b8g-allow-event-emitter')
  ) {
    const masked = maskJsTsComments(text)
    const eeMatch = /\bEventEmitter\b/.exec(masked)
    if (eeMatch) {
      pushDiag(
        diags,
        getLineStarts,
        filePath,
        'B8G020',
        3,
        'Intersection entrypoint uses `EventEmitter` without pure Web Streams (`streams-first-intersection`). Prefer `TransformStream`, `createPersonaTee`, or `composeIntersectionStreams` for backpressure-aware streaming, or annotate `// b8g-allow-event-emitter`.',
        eeMatch.index,
        eeMatch.index + eeMatch[0].length
      )
    }
  }

  // B8G021 (consumer-console-leak): Warn on console.warn(/console.debug( in sections/*/index.mts & intersections/*/index.mts
  if (
    DECLARATIVE_SECTION_ENTRY_RE.test(normPath) &&
    !isTestFile &&
    !/^cli/i.test(baseName) &&
    !DEVOPS_INTERSECTION_ENTRY_RE.test(normPath) &&
    (text.includes('console.warn') || text.includes('console.debug'))
  ) {
    const rawLines = text.split(/\r?\n/)
    const hasFileSuppression = rawLines.some((line) => {
      const trimmed = line.trim()
      return (
        (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) &&
        trimmed.includes('b8g-allow-console-warn')
      )
    })
    if (!hasFileSuppression) {
      const masked = maskJsTsComments(text)
      const consoleLeakRe = /\bconsole\.(?:warn|debug)\s*\(/g
      let cm: RegExpExecArray | null
      while ((cm = consoleLeakRe.exec(masked)) !== null) {
        const pos = offsetToPosition(getLineStarts(), cm.index)
        const rawLine = rawLines[pos.line] ?? ''
        if (rawLine.includes('b8g-allow-console-warn')) continue
        pushDiag(
          diags,
          getLineStarts,
          filePath,
          'B8G021',
          2,
          'Direct `console.warn`/`console.debug` call leaks internal diagnostics to consumer stdout/stderr (`consumer-console-leak`). Use `emitDevOpsEvent(...)` or `createPersonaTee(...)` to preserve Persona Isolation (`Omega = consumer => 0`), or annotate `// b8g-allow-console-warn`.',
          cm.index,
          cm.index + cm[0].length
        )
      }
    }
  }

  // B8G022 (untagged-html-template): Require leading `html` template tag on `<!DOCTYPE html` templates
  if (
    !isTestFile &&
    (ext === '.mts' || ext === '.ts' || ext === '.mjs' || ext === '.js') &&
    text.includes('<!DOCTYPE html')
  ) {
    const untaggedHtmlRe = /(?<![A-Za-z0-9_$])`(\s*<!DOCTYPE\s+html\b)/gi
    let hm: RegExpExecArray | null
    while ((hm = untaggedHtmlRe.exec(text)) !== null) {
      pushDiag(
        diags,
        getLineStarts,
        filePath,
        'B8G022',
        2,
        'Untagged HTML template literal (`<!DOCTYPE html`). Prefix with `html` tagged template (e.g. `` return html`<!DOCTYPE html>...` ``) for syntax highlighting and HTML auditability.',
        hm.index,
        hm.index + hm[0].length,
        {
          title: 'Prefix template literal with `html` tag',
          startOffset: hm.index,
          endOffset: hm.index + 1,
          replacement: 'html`',
        }
      )
    }
  }

  return applyOverrides(diags)
}

export function applyAuditFixes(text: string, diagnostics: readonly AuditDiagnostic[]): { text: string; fixedCount: number } {
  const fixes = diagnostics
    .map((d) => d.fix)
    .filter((f): f is AuditFix => Boolean(f))
    .sort((a, b) => b.startOffset - a.startOffset)

  if (fixes.length === 0) return { text, fixedCount: 0 }

  let out = text
  let lastAppliedStart = out.length + 1
  let fixedCount = 0
  for (const fx of fixes) {
    if (fx.endOffset > lastAppliedStart) continue
    out = out.slice(0, fx.startOffset) + fx.replacement + out.slice(fx.endOffset)
    lastAppliedStart = fx.startOffset
    fixedCount++
  }
  return { text: out, fixedCount }
}

const JS_BUF_TRIGGERS = [
  Buffer.from('findFiles('),
  Buffer.from('.get('),
  Buffer.from('#'),
  Buffer.from('Object.assign(this,'),
  Buffer.from('readdir'),
  Buffer.from('new Response('),
  Buffer.from('registerSchemesAsPrivileged('),
  Buffer.from('DecompressSync'),
  Buffer.from('import'),
  Buffer.from('require('),
  Buffer.from('process'),
  Buffer.from('createServer('),
  Buffer.from('Buffer'),
  Buffer.from('__dirname'),
  Buffer.from('__filename'),
  Buffer.from('</'),
  Buffer.from('<!doctype'),
]

const FW_BUF_KEYS = [...Object.keys(JS_FRAMEWORK_MAP), ...Object.keys(PY_FRAMEWORK_MAP)].map((k) =>
  Buffer.from(k)
)

/**
 * Zero-UTF16-decode raw byte gate: avoids allocating V8 strings when no trigger pattern exists in `buf`.
 */
export function auditSourceBuffer(
  filePath: string,
  buf: Buffer,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
  options?: {
    customRules?: CustomStealifyRule[]
    disableCustomRules?: boolean
    rootDir?: string
  }
): AuditDiagnostic[] | null {
  if (buf.byteLength > maxBytes) return null
  const baseName = path.basename(filePath).toLowerCase()
  if (
    baseName.endsWith('.d.ts') ||
    baseName.endsWith('.d.mts') ||
    baseName.endsWith('.d.cts') ||
    baseName.endsWith('.min.js') ||
    baseName.endsWith('.min.mjs')
  ) {
    return null
  }
  const ext = path.extname(baseName)
  const isPkgJson = baseName === 'package.json'
  if (isPkgJson) {
    let hasFw = false
    for (let i = 0; i < FW_BUF_KEYS.length; i++) {
      if (buf.includes(FW_BUF_KEYS[i])) {
        hasFw = true
        break
      }
    }
    return hasFw ||
      (!options?.disableCustomRules && (options?.customRules?.length || hasCustomRulesForPath(filePath, options?.rootDir)))
      ? auditSourceText(filePath, buf.toString('utf8'), options)
      : []
  }
  if (!JS_TS_EXTS.has(ext) && !PY_EXTS.has(ext) && !HTML_EXTS.has(ext) && !MD_EXTS.has(ext)) return null

  // Fast-path: if this path has custom rules configured, run full auditSourceText
  if (
    !options?.disableCustomRules &&
    (options?.customRules?.length || hasCustomRulesForPath(filePath, options?.rootDir))
  ) {
    return auditSourceText(filePath, buf.toString('utf8'), options)
  }

  let anyHit = false
  if (ext === '.py') {
    anyHit = buf.includes('os.walk(') || buf.includes('StaticFiles(') || buf.includes('import')
  } else if (HTML_EXTS.has(ext) || MD_EXTS.has(ext)) {
    anyHit = true
  } else {
    if (DECLARATIVE_SECTION_ENTRY_RE.test(filePath.replace(/\\/g, '/'))) {
      anyHit = true
    } else {
      for (let i = 0; i < JS_BUF_TRIGGERS.length; i++) {
        if (buf.includes(JS_BUF_TRIGGERS[i])) {
          anyHit = true
          break
        }
      }
    }
  }
  if (!anyHit) return []
  return auditSourceText(filePath, buf.toString('utf8'), options)
}

function collectAuditableFiles(targets: readonly string[]): { files: string[]; skipped: number } {
  const files: string[] = []
  let skipped = 0
  const stack: string[] = []

  const maybePushFile = (filePath: string) => {
    const lowerName = path.basename(filePath).toLowerCase()
    if (
      lowerName.endsWith('.d.ts') ||
      lowerName.endsWith('.d.mts') ||
      lowerName.endsWith('.d.cts') ||
      lowerName.endsWith('.min.js') ||
      lowerName.endsWith('.min.mjs')
    ) {
      skipped++
      return
    }
    const ext = path.extname(lowerName)
    if (JS_TS_EXTS.has(ext) || PY_EXTS.has(ext) || HTML_EXTS.has(ext) || MD_EXTS.has(ext) || lowerName === 'package.json') {
      files.push(filePath)
    }
  }

  for (const t of targets) {
    const resolved = path.resolve(t)
    if (!fs.existsSync(resolved)) continue
    const st = fs.statSync(resolved)
    if (st.isDirectory()) stack.push(resolved)
    else if (st.isFile()) maybePushFile(resolved)
  }

  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) stack.push(full)
      else if (ent.isFile()) maybePushFile(full)
    }
  }

  return { files, skipped }
}

export function scanAndAuditPaths(
  targets: readonly string[],
  options: { applyFixes?: boolean; maxFileBytes?: number } = {}
): AuditRunResult {
  const t0 = performance.now()
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const diagnostics: AuditDiagnostic[] = []
  const { files, skipped } = collectAuditableFiles(targets)
  let filesScanned = 0
  let filesSkipped = skipped

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]
    const buf = fs.readFileSync(filePath)
    if (buf.byteLength > maxBytes) {
      filesSkipped++
      continue
    }
    filesScanned++
    const found = auditSourceBuffer(filePath, buf, maxBytes) ?? []
    if (options.applyFixes && found.some((d) => d.fix)) {
      const patched = applyAuditFixes(buf.toString('utf8'), found)
      if (patched.fixedCount > 0) {
        fs.writeFileSync(filePath, patched.text, 'utf8')
        diagnostics.push(...auditSourceText(filePath, patched.text))
        continue
      }
    }
    if (found.length > 0) diagnostics.push(...found)
  }

  return {
    filesScanned,
    filesSkipped,
    durationMs: Number((performance.now() - t0).toFixed(2)),
    diagnostics,
  }
}

export async function scanAndAuditPathsAsync(
  targets: readonly string[],
  options: {
    applyFixes?: boolean
    maxFileBytes?: number
    concurrency?: number
    auditor?: (filePath: string, text: string) => { diagnostics: AuditDiagnostic[] }
  } = {}
): Promise<AuditRunResult> {
  const t0 = performance.now()
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const concurrency = options.concurrency ?? 64
  const diagnostics: AuditDiagnostic[] = []
  const { files, skipped } = collectAuditableFiles(targets)
  let filesScanned = 0
  let filesSkipped = skipped
  let cursor = 0

  const worker = async () => {
    while (cursor < files.length) {
      const filePath = files[cursor++]
      const buf = await fs.promises.readFile(filePath)
      if (buf.byteLength > maxBytes) {
        filesSkipped++
        continue
      }
      filesScanned++
      const found = options.auditor
        ? options.auditor(filePath, buf.toString('utf8')).diagnostics
        : (auditSourceBuffer(filePath, buf, maxBytes) ?? [])
      if (options.applyFixes && found.some((d) => d.fix)) {
        const patched = applyAuditFixes(buf.toString('utf8'), found)
        if (patched.fixedCount > 0) {
          await fs.promises.writeFile(filePath, patched.text, 'utf8')
          diagnostics.push(...auditSourceText(filePath, patched.text))
          continue
        }
      }
      if (found.length > 0) diagnostics.push(...found)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, files.length)) }, () => worker())
  await Promise.all(workers)

  return {
    filesScanned,
    filesSkipped,
    durationMs: Number((performance.now() - t0).toFixed(2)),
    diagnostics,
  }
}
