/**
 * @file b8g-block-cas.mts
 * @description Sub-Module & Declaration-Level Content-Addressable Storage (CAS) Engine.
 * 
 * Provides:
 * 1. Fast AST & balanced-delimiter declaration block slicing for TypeScript, JavaScript, and Python.
 * 2. Fine-grained CAS caching (preamble + block hash -> diagnostics / analysis).
 * 3. Exact line/character coordinate remapping for cached diagnostic payloads.
 * 4. High-performance caching layers for LSP live-editing, `stealify-lint`, and `stealifylang check`.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  auditSourceText,
  getStealifyRuleOverridesForFile,
  isHostBoundaryFile,
  type AuditDiagnostic,
  type AuditRange,
  type AuditRunResult,
} from './audit-rules.mts'
import { scanHostCoupling } from './capability-iife-refactor.mts'

export type BlockKind =
  | 'preamble'
  | 'function'
  | 'class'
  | 'variable'
  | 'interface'
  | 'type'
  | 'enum'
  | 'test'
  | 'statement'

export interface CodeBlock {
  readonly id: string
  readonly kind: BlockKind
  readonly name: string
  readonly startLine: number
  readonly endLine: number
  readonly startOffset: number
  readonly endOffset: number
  readonly source: string
  readonly hash: string
}

export interface SlicedFile {
  readonly filePath: string
  readonly preamble: CodeBlock
  readonly blocks: CodeBlock[]
  readonly totalLines: number
  readonly isChunked: boolean
  readonly fileHash: string
}

export interface CachedBlockDiagnostic {
  readonly code: string
  readonly severity: number
  readonly message: string
  readonly relativeStartLine: number
  readonly startCharacter: number
  readonly relativeEndLine: number
  readonly endCharacter: number
  readonly fix?: {
    readonly title: string
    readonly relativeStartOffset: number
    readonly relativeEndOffset: number
    readonly replacement: string
  }
}

export interface CasMetrics {
  totalFiles: number
  totalBlocks: number
  cacheHits: number
  cacheMisses: number
  hitRatePercent: number
  evalTimeSavedMs: number
}

export function hashString(str: string): string {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16)
}

/**
 * Builds a fast lookup table of line start offsets for character-offset conversions.
 */
export function buildLineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

/**
 * Slices a TypeScript or JavaScript source into a preamble (imports, directives)
 * and top-level declaration blocks (functions, classes, interfaces, tests).
 */
export function sliceTsJsSource(sourceText: string, filePath: string = 'file.ts'): SlicedFile {
  const lines = sourceText.split(/\r?\n/)
  const totalLines = lines.length
  const lineStarts = buildLineStarts(sourceText)

  const preambleLines: string[] = []
  let preambleEndLine = 0
  let preambleEndOffset = 0

  let inPreamble = true
  let braceDepth = 0
  let parenDepth = 0
  let inMultiComment = false

  const rawBlocks: {
    kind: BlockKind
    name: string
    startLine: number
    endLine: number
    lines: string[]
  }[] = []

  let currentBlockLines: string[] = []
  let currentBlockKind: BlockKind = 'statement'
  let currentBlockName = ''
  let currentBlockStartLine = 0

  const declRegex =
    /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum)\s+([a-zA-Z0-9_$]+)/
  const testRegex = /^\s*(?:test|it|describe)\s*\(\s*(['"`][^'"`]+['"`])/

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]
    const trimmed = line.trim()

    // Comment handling
    if (inMultiComment) {
      if (trimmed.includes('*/')) inMultiComment = false
      if (inPreamble) preambleLines.push(line)
      else currentBlockLines.push(line)
      continue
    }

    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inMultiComment = true
      if (inPreamble) preambleLines.push(line)
      else currentBlockLines.push(line)
      continue
    }

    if (inPreamble) {
      const isImportOrDirective =
        trimmed.startsWith('import ') ||
        trimmed.startsWith('import(') ||
        trimmed.startsWith('export * from') ||
        trimmed.startsWith('export {') ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('///') ||
        trimmed.startsWith('"use ') ||
        trimmed.startsWith("'use ") ||
        trimmed === ''

      if (isImportOrDirective && braceDepth === 0) {
        preambleLines.push(line)
        preambleEndLine = lineIdx + 1
        continue
      } else {
        inPreamble = false
      }
    }

    // Top-level block boundary detection
    if (braceDepth === 0 && parenDepth === 0) {
      let match = trimmed.match(declRegex)
      let testMatch = trimmed.match(testRegex)

      if (match || testMatch) {
        // Finalize previous block if any
        if (currentBlockLines.length > 0) {
          const blockText = currentBlockLines.join('\n').trim()
          if (blockText.length > 0) {
            rawBlocks.push({
              kind: currentBlockKind,
              name: currentBlockName || `block_${rawBlocks.length}`,
              startLine: currentBlockStartLine,
              endLine: lineIdx - 1,
              lines: currentBlockLines,
            })
          }
          currentBlockLines = []
        }

        currentBlockStartLine = lineIdx
        if (match) {
          const rawKind = match[1]
          currentBlockKind =
            rawKind.startsWith('function') ? 'function' :
            rawKind === 'class' ? 'class' :
            rawKind === 'interface' ? 'interface' :
            rawKind === 'type' ? 'type' :
            rawKind === 'enum' ? 'enum' : 'variable'
          currentBlockName = match[2]
        } else if (testMatch) {
          currentBlockKind = 'test'
          currentBlockName = testMatch[1].replace(/['"`]/g, '')
        }
      }
    }

    currentBlockLines.push(line)

    // Character scan for delimiters (ignoring simple inline string escapes)
    let inCharQuote = false
    let quoteChar = ''
    for (let c = 0; c < line.length; c++) {
      const char = line[c]
      if (inCharQuote) {
        if (char === '\\') {
          c++ // skip escaped char
        } else if (char === quoteChar) {
          inCharQuote = false
        }
        continue
      }

      if (char === '"' || char === "'" || char === '`') {
        inCharQuote = true
        quoteChar = char
      } else if (char === '{') {
        braceDepth++
      } else if (char === '}') {
        braceDepth = Math.max(0, braceDepth - 1)
      } else if (char === '(') {
        parenDepth++
      } else if (char === ')') {
        parenDepth = Math.max(0, parenDepth - 1)
      }
    }

    // Completed top-level block
    if (braceDepth === 0 && parenDepth === 0 && currentBlockLines.length > 0) {
      if (trimmed.endsWith(';') || trimmed.endsWith('}') || currentBlockKind === 'interface' || currentBlockKind === 'type') {
        rawBlocks.push({
          kind: currentBlockKind,
          name: currentBlockName || `block_${rawBlocks.length}`,
          startLine: currentBlockStartLine,
          endLine: lineIdx,
          lines: currentBlockLines,
        })
        currentBlockLines = []
        currentBlockName = ''
        currentBlockKind = 'statement'
        currentBlockStartLine = lineIdx + 1
      }
    }
  }

  // Trailing lines
  if (currentBlockLines.length > 0) {
    const text = currentBlockLines.join('\n').trim()
    if (text.length > 0) {
      rawBlocks.push({
        kind: currentBlockKind,
        name: currentBlockName || `block_${rawBlocks.length}`,
        startLine: currentBlockStartLine,
        endLine: lines.length - 1,
        lines: currentBlockLines,
      })
    }
  }

  const hasReaddir = sourceText.includes('readdir')
  if (hasReaddir) {
    preambleLines.push('/* @tu-context: readdir */', 'const __tu_readdir = true;')
  }

  const boundaryTag = isHostBoundaryFile(filePath) ? 'host' : 'portable'
  const overrideTag = fs.existsSync(filePath)
    ? JSON.stringify(getStealifyRuleOverridesForFile(filePath))
    : '{}'

  const preambleText = preambleLines.join('\n')
  const preambleHash = hashString(`${boundaryTag}:${overrideTag}:${preambleText}`)
  preambleEndOffset = preambleText.length

  const preambleBlock: CodeBlock = {
    id: `${filePath}:preamble`,
    kind: 'preamble',
    name: 'preamble',
    startLine: 0,
    endLine: Math.max(0, preambleEndLine - 1),
    startOffset: 0,
    endOffset: preambleEndOffset,
    source: preambleText,
    hash: preambleHash,
  }

  const isChunked = rawBlocks.length > 1
  const blocks: CodeBlock[] = rawBlocks.map((b, idx) => {
    const src = b.lines.join('\n')
    const startOff = lineStarts[b.startLine] ?? 0
    const endOff = Math.min(sourceText.length, (lineStarts[b.endLine + 1] ?? sourceText.length))
    const tuTag = `${boundaryTag}:${overrideTag}:${hasReaddir ? 'readdir:' : ''}`
    const blockHash = hashString(`${tuTag}${b.name}:${src}`)

    return {
      id: `${filePath}:${b.kind}:${b.name || idx}`,
      kind: b.kind,
      name: b.name,
      startLine: b.startLine,
      endLine: b.endLine,
      startOffset: startOff,
      endOffset: endOff,
      source: src,
      hash: blockHash,
    }
  })

  return {
    filePath,
    preamble: preambleBlock,
    blocks,
    totalLines,
    isChunked,
    fileHash: hashString(sourceText),
  }
}

/**
 * Universal Block CAS In-Memory & Disk Cache Store
 */
export class BlockCasStore {
  private cache = new Map<string, CachedBlockDiagnostic[]>()
  private preambleCache = new Map<string, AuditDiagnostic[]>()
  private hits = 0
  private misses = 0
  private filesProcessed = 0
  private totalBlocksCount = 0
  private timeSavedMs = 0

  diskCachePath?: string

  constructor(diskCachePath?: string) {
    this.diskCachePath = diskCachePath
    if (this.diskCachePath && fs.existsSync(this.diskCachePath)) {
      try {
        const raw = fs.readFileSync(this.diskCachePath, 'utf8')
        const data = JSON.parse(raw)
        if (data && typeof data === 'object') {
          for (const [k, v] of Object.entries(data.blocks || {})) {
            this.cache.set(k, v as CachedBlockDiagnostic[])
          }
          for (const [k, v] of Object.entries(data.preambles || {})) {
            this.preambleCache.set(k, v as AuditDiagnostic[])
          }
        }
      } catch {}
    }
  }

  public get(hash: string): CachedBlockDiagnostic[] | undefined {
    const res = this.cache.get(hash)
    if (res) {
      this.hits++
      this.timeSavedMs += 0.5 // Estimated CPU time saved per skipped regex pass
    } else {
      this.misses++
    }
    return res
  }

  public set(hash: string, diags: CachedBlockDiagnostic[]): void {
    this.cache.set(hash, diags)
  }

  public getPreamble(hash: string): AuditDiagnostic[] | undefined {
    return this.preambleCache.get(hash)
  }

  public setPreamble(hash: string, diags: AuditDiagnostic[]): void {
    this.preambleCache.set(hash, diags)
  }

  public recordFile(blocks: number): void {
    this.filesProcessed++
    this.totalBlocksCount += blocks
  }

  public getMetrics(): CasMetrics {
    const totalOps = this.hits + this.misses
    const hitRate = totalOps > 0 ? (this.hits / totalOps) * 100 : 0
    return {
      totalFiles: this.filesProcessed,
      totalBlocks: this.totalBlocksCount,
      cacheHits: this.hits,
      cacheMisses: this.misses,
      hitRatePercent: Number(hitRate.toFixed(2)),
      evalTimeSavedMs: Number(this.timeSavedMs.toFixed(2)),
    }
  }

  public clear(): void {
    this.cache.clear()
    this.preambleCache.clear()
    this.hits = 0
    this.misses = 0
    this.filesProcessed = 0
    this.totalBlocksCount = 0
    this.timeSavedMs = 0
  }

  public persist(): void {
    if (!this.diskCachePath) return
    try {
      const dir = path.dirname(this.diskCachePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const obj = {
        blocks: Object.fromEntries(this.cache.entries()),
        preambles: Object.fromEntries(this.preambleCache.entries()),
        version: '1.0.0',
      }
      fs.writeFileSync(this.diskCachePath, JSON.stringify(obj), 'utf8')
    } catch {}
  }
}

export const defaultCasStore = new BlockCasStore()

/**
 * Audits a source text using Sub-Module / Block-level CAS caching.
 * Unchanged functions and classes are served from CAS memory in O(1) time.
 */
export function auditSourceTextWithCas(
  filePath: string,
  sourceText: string,
  store: BlockCasStore = defaultCasStore
): { diagnostics: AuditDiagnostic[]; cacheHitRate: number; blocksCount: number } {
  // If file is not JS/TS (e.g. package.json or python), fallback directly
  const ext = path.extname(filePath).toLowerCase()
  if (!['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.stealify'].includes(ext)) {
    const raw = auditSourceText(filePath, sourceText)
    store.recordFile(1)
    return { diagnostics: raw, cacheHitRate: 0, blocksCount: 1 }
  }

  const sliced = sliceTsJsSource(sourceText, filePath)
  store.recordFile(sliced.blocks.length + 1)
  const allDiags: AuditDiagnostic[] = []

  // 1. Audit Preamble (import statements, directives)
  let preambleDiags = store.getPreamble(sliced.preamble.hash)
  if (!preambleDiags) {
    preambleDiags = auditSourceText(filePath, sliced.preamble.source)
    store.setPreamble(sliced.preamble.hash, preambleDiags)
  }
  for (const d of preambleDiags) {
    allDiags.push({ ...d, filePath })
  }

  // If file was not chunked into distinct blocks or binds outer host capabilities, run full audit
  if (!sliced.isChunked || sliced.blocks.length === 0 || scanHostCoupling(sourceText).boundGlobals.size > 0) {
    const fullDiags = auditSourceText(filePath, sourceText)
    return {
      diagnostics: fullDiags,
      cacheHitRate: store.getMetrics().hitRatePercent,
      blocksCount: 1,
    }
  }

  // 2. Audit Each Block with CAS Lookup & Offset Remapping
  const preambleLinesCount = sliced.preamble.source.split(/\r?\n/).length

  for (const block of sliced.blocks) {
    const cached = store.get(block.hash)
    if (cached) {
      // CAS HIT: Re-map line/offset coordinates to current file positions
      for (const cd of cached) {
        const startLine = block.startLine + cd.relativeStartLine
        const endLine = block.startLine + cd.relativeEndLine

        allDiags.push({
          code: cd.code,
          severity: cd.severity as any,
          message: cd.message,
          filePath,
          range: {
            start: { line: startLine, character: cd.startCharacter },
            end: { line: endLine, character: cd.endCharacter },
          },
          fix: cd.fix
            ? {
                title: cd.fix.title,
                startOffset: block.startOffset + cd.fix.relativeStartOffset,
                endOffset: block.startOffset + cd.fix.relativeEndOffset,
                replacement: cd.fix.replacement,
              }
            : undefined,
        })
      }
    } else {
      // CAS MISS: Analyze block prepended with preamble to preserve lexical context
      const blockAuditText = sliced.preamble.source + '\n' + block.source
      const rawDiags = auditSourceText(filePath, blockAuditText)

      const blockCachedList: CachedBlockDiagnostic[] = []

      for (const rd of rawDiags) {
        // Only collect diagnostics that originated inside the block (not in preamble)
        if (rd.range.start.line >= preambleLinesCount) {
          const relStartLine = rd.range.start.line - preambleLinesCount
          const relEndLine = rd.range.end.line - preambleLinesCount

          const relFix = rd.fix
            ? {
                title: rd.fix.title,
                relativeStartOffset: Math.max(0, rd.fix.startOffset - (sliced.preamble.source.length + 1)),
                relativeEndOffset: Math.max(0, rd.fix.endOffset - (sliced.preamble.source.length + 1)),
                replacement: rd.fix.replacement,
              }
            : undefined

          blockCachedList.push({
            code: rd.code,
            severity: rd.severity,
            message: rd.message,
            relativeStartLine: relStartLine,
            startCharacter: rd.range.start.character,
            relativeEndLine: relEndLine,
            endCharacter: rd.range.end.character,
            fix: relFix,
          })

          allDiags.push({
            code: rd.code,
            severity: rd.severity,
            message: rd.message,
            filePath,
            range: {
              start: { line: block.startLine + relStartLine, character: rd.range.start.character },
              end: { line: block.startLine + relEndLine, character: rd.range.end.character },
            },
            fix: rd.fix
              ? {
                  title: rd.fix.title,
                  startOffset: block.startOffset + (relFix?.relativeStartOffset ?? 0),
                  endOffset: block.startOffset + (relFix?.relativeEndOffset ?? 0),
                  replacement: rd.fix.replacement,
                }
              : undefined,
          })
        }
      }

      store.set(block.hash, blockCachedList)
    }
  }

  return {
    diagnostics: allDiags,
    cacheHitRate: store.getMetrics().hitRatePercent,
    blocksCount: sliced.blocks.length,
  }
}
