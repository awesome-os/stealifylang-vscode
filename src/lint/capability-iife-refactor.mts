/**
 * @module
 * Rollup-IIFE Capability Wrapper Auto-Refactorer & `.host.mts` Emitter.
 *
 * Scans TS/JS source for ambient host globals (`process`, `Buffer`, `__dirname`, `__filename`)
 * and direct `node:*` imports, and automatically wraps portable modules into:
 *   `export const create<Name> = (caps: <Name>Capabilities) => { ... return { ...exports }; }`
 * plus an optional `<stem>.host.mts` Node runtime binder.
 *
 * Strictly zero `node:*` dependencies and `erasableSyntaxOnly: true`.
 */

export type AmbientHostGlobalName = 'process' | 'Buffer' | '__dirname' | '__filename'

export interface NodeCapMapping {
  readonly spec: string
  readonly capKey: string
  readonly capType: string
  readonly nodeImport: string
  readonly namespaceImport?: boolean
}

export interface HostImportBinding {
  readonly kind: 'default' | 'namespace' | 'named' | 'side-effect'
  readonly importedName?: string
  readonly localName: string
}

export interface HostImportMatch {
  readonly spec: string
  readonly capKey: string
  readonly capType: string
  readonly nodeImport: string
  readonly namespaceImport: boolean
  readonly isTypeOnly: boolean
  readonly statementText: string
  readonly startOffset: number
  readonly endOffset: number
  readonly line: number
  readonly character: number
  readonly bindings: HostImportBinding[]
}

export interface HostRequireMatch {
  readonly spec: string
  readonly capKey: string
  readonly capType: string
  readonly nodeImport: string
  readonly startOffset: number
  readonly endOffset: number
  readonly line: number
  readonly character: number
}

export interface HostGlobalMatch {
  readonly name: AmbientHostGlobalName
  readonly capType: string
  readonly startOffset: number
  readonly endOffset: number
  readonly line: number
  readonly character: number
  readonly byteLengthFix?: {
    readonly startOffset: number
    readonly endOffset: number
    readonly replacement: string
  }
}

export interface HostCouplingReport {
  readonly imports: HostImportMatch[]
  readonly requires: HostRequireMatch[]
  readonly globals: HostGlobalMatch[]
  readonly boundGlobals: Set<AmbientHostGlobalName>
}

export interface RequiredCapabilitySpec {
  readonly key: string
  readonly typeName: string
  readonly nodeImport?: string
  readonly namespaceImport?: boolean
  readonly optional?: boolean
}

export interface CapabilityRefactorOptions {
  readonly filePath?: string
  readonly capabilitiesImportPath?: string
  readonly factoryName?: string
}

export interface CapabilityRefactorResult {
  readonly changed: boolean
  readonly code: string
  readonly factoryName: string
  readonly capabilitiesInterfaceName: string
  readonly requiredCaps: RequiredCapabilitySpec[]
  readonly exportedValues: string[]
  readonly exportedTypes: string[]
  readonly hadShebang: boolean
}

const NODE_BUILTIN_TABLE: Record<string, Omit<NodeCapMapping, 'spec'>> = {
  fs: { capKey: 'fs', capType: 'FsLike', nodeImport: 'node:fs' },
  'fs/promises': { capKey: 'fsPromises', capType: 'FsPromisesLike', nodeImport: 'node:fs/promises', namespaceImport: true },
  net: { capKey: 'net', capType: 'NetLike', nodeImport: 'node:net' },
  http: { capKey: 'http', capType: 'HttpLike', nodeImport: 'node:http' },
  https: { capKey: 'https', capType: 'HttpsLike', nodeImport: 'node:https' },
  tls: { capKey: 'tls', capType: 'TlsLike', nodeImport: 'node:tls' },
  child_process: { capKey: 'child_process', capType: 'SpawnLike', nodeImport: 'node:child_process', namespaceImport: true },
  os: { capKey: 'os', capType: 'OsLike', nodeImport: 'node:os' },
  path: { capKey: 'path', capType: 'PathLike', nodeImport: 'node:path' },
  url: { capKey: 'url', capType: 'UrlLike', nodeImport: 'node:url', namespaceImport: true },
  crypto: { capKey: 'crypto', capType: 'CryptoLike', nodeImport: 'node:crypto' },
  zlib: { capKey: 'zlib', capType: 'ZlibLike', nodeImport: 'node:zlib' },
  perf_hooks: { capKey: 'perf_hooks', capType: 'PerfHooksLike', nodeImport: 'node:perf_hooks', namespaceImport: true },
}

const AMBIENT_GLOBAL_TYPES: Record<AmbientHostGlobalName, string> = {
  process: 'ProcessLike',
  Buffer: 'BufferStaticLike',
  __dirname: 'string',
  __filename: 'string',
}

export function resolveNodeBuiltinMapping(spec: string): NodeCapMapping | null {
  const clean = spec.trim()
  const isNodePrefixed = clean.startsWith('node:')
  const bare = isNodePrefixed ? clean.slice(5) : clean
  if (NODE_BUILTIN_TABLE[bare]) {
    return { spec: clean, ...NODE_BUILTIN_TABLE[bare] }
  }
  if (!isNodePrefixed) return null
  const capKey = bare.replace(/[^a-zA-Z0-9_$]/g, '_')
  return {
    spec: clean,
    capKey,
    capType: 'Record<string, any>',
    nodeImport: clean,
    namespaceImport: true,
  }
}

interface Token {
  readonly kind: 'ident' | 'string' | 'number' | 'punct'
  readonly value: string
  readonly start: number
  readonly end: number
}

function isIdentStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36
}

function isIdentPart(c: number): boolean {
  return isIdentStart(c) || (c >= 48 && c <= 57)
}

function computeLineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

function offsetToLineCol(lineStarts: number[], offset: number): { line: number; character: number } {
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

/**
 * Quote-, comment-, and template-interpolation-aware tokenizer.
 */
function tokenizeSource(text: string): Token[] {
  const tokens: Token[] = []
  const n = text.length
  let i = 0

  // Template state stack: each entry tracks brace depth inside `${ ... }`
  const templateBraceDepths: number[] = []
  let currentBraceDepth = 0

  const skipQuoted = (quoteChar: number, startIdx: number): number => {
    let j = startIdx + 1
    while (j < n) {
      const c = text.charCodeAt(j)
      if (c === 92) {
        j += 2
        continue
      }
      if (c === quoteChar) return j + 1
      j++
    }
    return n
  }

  const scanTemplateChunk = (startIdx: number, includeLeadingBacktick: boolean): number => {
    let j = includeLeadingBacktick ? startIdx + 1 : startIdx
    while (j < n) {
      const c = text.charCodeAt(j)
      if (c === 92) {
        j += 2
        continue
      }
      if (c === 96) {
        return j + 1
      }
      if (c === 36 && j + 1 < n && text.charCodeAt(j + 1) === 123) {
        // `${` opens an interpolation expression
        templateBraceDepths.push(currentBraceDepth)
        currentBraceDepth++
        tokens.push({ kind: 'punct', value: '${', start: j, end: j + 2 })
        return j + 2
      }
      j++
    }
    return n
  }

  while (i < n) {
    const c = text.charCodeAt(i)

    // Whitespace
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++
      continue
    }

    // Shebang at file start
    if (i === 0 && c === 35 && text.charCodeAt(1) === 33) {
      while (i < n && text.charCodeAt(i) !== 10) i++
      continue
    }

    // Comments
    if (c === 47 && i + 1 < n) {
      const next = text.charCodeAt(i + 1)
      if (next === 47) {
        i += 2
        while (i < n && text.charCodeAt(i) !== 10) i++
        continue
      }
      if (next === 42) {
        i += 2
        while (i + 1 < n && !(text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47)) i++
        i = i + 2 <= n ? i + 2 : n
        continue
      }
    }

    // Single / Double string literals
    if (c === 39 || c === 34) {
      const end = skipQuoted(c, i)
      tokens.push({ kind: 'string', value: text.slice(i, end), start: i, end })
      i = end
      continue
    }

    // Backtick template string start
    if (c === 96) {
      const end = scanTemplateChunk(i, true)
      i = end
      continue
    }

    // RegExp literal heuristic (prevent `/` regex literals from hiding string tokens)
    if (c === 47) {
      const prev = tokens[tokens.length - 1]
      const canStartRegex =
        !prev ||
        (prev.kind === 'punct' && !['}', ')', ']', '++', '--'].includes(prev.value)) ||
        (prev.kind === 'ident' && ['return', 'case', 'throw', 'typeof', 'void', 'delete', 'await', 'yield', 'else'].includes(prev.value))
      if (canStartRegex) {
        let j = i + 1
        let inClass = false
        let closed = false
        while (j < n) {
          const rc = text.charCodeAt(j)
          if (rc === 10 || rc === 13) break
          if (rc === 92) {
            j += 2
            continue
          }
          if (rc === 91) inClass = true
          else if (rc === 93) inClass = false
          else if (rc === 47 && !inClass) {
            closed = true
            j++
            while (j < n && isIdentStart(text.charCodeAt(j))) j++
            break
          }
          j++
        }
        if (closed) {
          tokens.push({ kind: 'punct', value: '/', start: i, end: j })
          i = j
          continue
        }
      }
    }

    // Identifiers
    if (isIdentStart(c)) {
      let j = i + 1
      while (j < n && isIdentPart(text.charCodeAt(j))) j++
      tokens.push({ kind: 'ident', value: text.slice(i, j), start: i, end: j })
      i = j
      continue
    }

    // Numbers
    if (c >= 48 && c <= 57) {
      let j = i + 1
      while (j < n && (isIdentPart(text.charCodeAt(j)) || text.charCodeAt(j) === 46)) j++
      tokens.push({ kind: 'number', value: text.slice(i, j), start: i, end: j })
      i = j
      continue
    }

    // Closing brace: check if returning into a template literal
    if (c === 125) {
      currentBraceDepth = Math.max(0, currentBraceDepth - 1)
      tokens.push({ kind: 'punct', value: '}', start: i, end: i + 1 })
      if (
        templateBraceDepths.length > 0 &&
        currentBraceDepth === templateBraceDepths[templateBraceDepths.length - 1]
      ) {
        templateBraceDepths.pop()
        i = scanTemplateChunk(i + 1, false)
        continue
      }
      i++
      continue
    }

    if (c === 123) {
      currentBraceDepth++
      tokens.push({ kind: 'punct', value: '{', start: i, end: i + 1 })
      i++
      continue
    }

    if (c === 63 && i + 1 < n && text.charCodeAt(i + 1) === 46) {
      tokens.push({ kind: 'punct', value: '?.', start: i, end: i + 2 })
      i += 2
      continue
    }

    if (c === 61 && i + 1 < n && text.charCodeAt(i + 1) === 62) {
      tokens.push({ kind: 'punct', value: '=>', start: i, end: i + 2 })
      i += 2
      continue
    }

    tokens.push({ kind: 'punct', value: text[i], start: i, end: i + 1 })
    i++
  }

  return tokens
}

function unquote(lit: string): string {
  return lit.length >= 2 ? lit.slice(1, -1) : lit
}

function parseImportBindings(clauseText: string): HostImportBinding[] {
  const cleaned = clauseText.replace(/^type\s+/, '').trim()
  if (!cleaned) return []

  const bindings: HostImportBinding[] = []
  let rest = cleaned

  // Check namespace or default before comma
  const braceIdx = rest.indexOf('{')
  const head = braceIdx >= 0 ? rest.slice(0, braceIdx).trim().replace(/,$/, '').trim() : rest
  if (head) {
    if (head.startsWith('*')) {
      const m = /^\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(head)
      if (m) {
        bindings.push({ kind: 'namespace', localName: m[1] })
      }
    } else {
      const parts = head.split(',').map((s) => s.trim()).filter(Boolean)
      for (const part of parts) {
        if (part.startsWith('*')) {
          const m = /^\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(part)
          if (m) bindings.push({ kind: 'namespace', localName: m[1] })
        } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) {
          bindings.push({ kind: 'default', localName: part })
        }
      }
    }
  }

  if (braceIdx >= 0) {
    const closeIdx = rest.lastIndexOf('}')
    if (closeIdx > braceIdx) {
      const inner = rest.slice(braceIdx + 1, closeIdx)
      for (const rawItem of inner.split(',')) {
        const item = rawItem.trim()
        if (!item || item.startsWith('type ')) continue
        const m = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(item)
        if (m) {
          bindings.push({
            kind: 'named',
            importedName: m[1],
            localName: m[2] ?? m[1],
          })
        }
      }
    }
  }

  return bindings
}

const AMBIENT_SET = new Set<string>(['process', 'Buffer', '__dirname', '__filename'])

/**
 * Scans TS/JS source for host imports (`node:*` / bare built-ins / `require`) and
 * unbound runtime references to `process`, `Buffer`, `__dirname`, and `__filename`.
 */
export function scanHostCoupling(text: string): HostCouplingReport {
  const lineStarts = computeLineStarts(text)
  const tokens = tokenizeSource(text)
  const imports: HostImportMatch[] = []
  const requires: HostRequireMatch[] = []
  const globals: HostGlobalMatch[] = []
  const boundGlobals = new Set<AmbientHostGlobalName>()

  // Pass 1: Identify lexically declared capability/local names (params, const/let/var, destructuring)
  let braceDepth = 0
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.kind === 'punct' && tok.value === '{') {
      braceDepth++
      continue
    }
    if (tok.kind === 'punct' && tok.value === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      continue
    }

    if (tok.kind === 'ident' && (tok.value === 'const' || tok.value === 'let' || tok.value === 'var')) {
      const next = tokens[i + 1]
      if (next && next.kind === 'ident' && AMBIENT_SET.has(next.value)) {
        boundGlobals.add(next.value as AmbientHostGlobalName)
      } else if (next && next.kind === 'punct' && next.value === '{') {
        let j = i + 2
        let bd = 1
        while (j < tokens.length && bd > 0) {
          if (tokens[j].kind === 'punct' && tokens[j].value === '{') bd++
          else if (tokens[j].kind === 'punct' && tokens[j].value === '}') bd--
          else if (tokens[j].kind === 'ident' && AMBIENT_SET.has(tokens[j].value)) {
            const after = tokens[j + 1]
            // `{ Buffer }` or `{ Buffer: b }` where `b` is local name (unless alias `a: Buffer`!)
            const before = tokens[j - 1]
            if (!(before && before.kind === 'punct' && before.value === ':')) {
              if (!after || after.value !== ':') {
                boundGlobals.add(tokens[j].value as AmbientHostGlobalName)
              }
            } else {
              // `{ process: process }` or `{ p: process }` binds `process`
              boundGlobals.add(tokens[j].value as AmbientHostGlobalName)
            }
          }
          j++
        }
      }
      continue
    }

    // Parameter bindings like `(caps, process: ProcessLike)` or `({ process, Buffer }: Caps)`
    if (
      tok.kind === 'ident' &&
      AMBIENT_SET.has(tok.value) &&
      i > 0 &&
      (tokens[i - 1].value === '(' || tokens[i - 1].value === ',' || tokens[i - 1].value === '{')
    ) {
      const after = tokens[i + 1]
      // Inside type signature `(caps: ..., process: ...)` only if `function` or `=>` precedes/follows param list;
      // Checking if followed by `:` and NOT inside `{ key: val }` object literal (value literal would not match ambient name as value unless shorthand):
      if (after && (after.value === ':' || after.value === ',' || after.value === ')' || after.value === '}')) {
        // Distinguish `{ Buffer: PortableBuffer }` vs parameter `(Buffer: BufferStaticLike)`:
        // Look backward to find enclosing delimiter `(`, `[`, `{`
        let parenScan = i - 1
        let dP = 0
        let dB = 0
        while (parenScan >= 0) {
          const pv = tokens[parenScan].value
          if (pv === ')') dP++
          else if (pv === '(') {
            if (dP === 0) break
            dP--
          } else if (pv === '}') dB++
          else if (pv === '{') {
            if (dB === 0) break
            dB--
          }
          parenScan--
        }
        const opener = parenScan >= 0 ? tokens[parenScan].value : ''
        const prevBeforeOpener = parenScan > 0 ? tokens[parenScan - 1] : null
        if (
          opener === '(' &&
          prevBeforeOpener &&
          (prevBeforeOpener.value === 'function' ||
            tokens[parenScan + 1]?.kind === 'ident' && after.value === ':' ||
            (prevBeforeOpener.kind === 'ident' && !['if', 'for', 'while', 'switch', 'catch'].includes(prevBeforeOpener.value)))
        ) {
          boundGlobals.add(tok.value as AmbientHostGlobalName)
        }
      }
    }
  }

  // Pass 2: Extract ES import statements (`import ... from 'node:...'` or bare Node built-ins)
  braceDepth = 0
  let inTypeBlockDepth = -1
  let inTypeAnnotation = false
  let inTypeAlias = false
  let typeExpectsArrow = false
  let typeAngleDepth = 0
  let ternaryDepth = 0
  const ctxStack: Array<'code' | 'objLiteral' | 'typeBlock'> = []

  const topCtx = (): 'code' | 'objLiteral' | 'typeBlock' =>
    ctxStack.length > 0 ? ctxStack[ctxStack.length - 1] : 'code'

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    const prev = i > 0 ? tokens[i - 1] : null
    const next = i + 1 < tokens.length ? tokens[i + 1] : null

    if (tok.kind === 'punct' && tok.value === '{') {
      braceDepth++
      if (inTypeBlockDepth >= 0 || inTypeAlias) {
        ctxStack.push('typeBlock')
      } else if (inTypeAnnotation) {
        if (prev && (prev.value === ':' || prev.value === '|' || prev.value === '&' || prev.value === '=')) {
          ctxStack.push('typeBlock')
        } else {
          inTypeAnnotation = false
          typeExpectsArrow = false
          ctxStack.push('code')
        }
      } else if (
        prev &&
        ['=', 'return', '(', ',', '[', ':', '=>', '?', 'throw', '&&', '||', '??'].includes(prev.value)
      ) {
        ctxStack.push('objLiteral')
      } else {
        ctxStack.push('code')
      }
    } else if (tok.kind === 'punct' && tok.value === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      ctxStack.pop()
      if (inTypeBlockDepth >= 0 && braceDepth < inTypeBlockDepth) {
        inTypeBlockDepth = -1
      }
      if (inTypeAnnotation && topCtx() !== 'typeBlock' && braceDepth === 0) {
        inTypeAnnotation = false
        typeExpectsArrow = false
      }
      if (inTypeAlias && braceDepth === 0 && typeAngleDepth === 0) {
        inTypeAlias = false
      }
    }

    // Track `interface Foo { ... }` and `type Bar = ...` top-level type regions
    if (
      inTypeBlockDepth < 0 &&
      tok.kind === 'ident' &&
      (tok.value === 'interface' || tok.value === 'type') &&
      (!prev || prev.value === 'export' || prev.value === ';' || prev.value === '}' || prev.value === '{')
    ) {
      if (tok.value === 'interface') {
        let j = i + 1
        while (j < tokens.length && tokens[j].value !== '{') j++
        if (j < tokens.length) {
          inTypeBlockDepth = braceDepth + 1
        }
        continue
      }
      if (tok.value === 'type' && next && next.kind === 'ident' && tokens[i + 2]?.value !== 'from') {
        inTypeAlias = true
        inTypeAnnotation = true
        typeAngleDepth = 0
        continue
      }
    }

    // Exit `type Foo = Bar` at newline when no `;` terminator is written
    if (
      inTypeAlias &&
      typeAngleDepth === 0 &&
      topCtx() !== 'typeBlock' &&
      prev &&
      prev.end < tok.start &&
      text.slice(prev.end, tok.start).includes('\n') &&
      tok.value !== '|' &&
      tok.value !== '&' &&
      prev.value !== '|' &&
      prev.value !== '&' &&
      prev.value !== '='
    ) {
      inTypeAlias = false
      inTypeAnnotation = false
      typeExpectsArrow = false
    }

    // Track ternary `?` vs type annotations `:` (ignore `:` inside object literals!)
    if (tok.kind === 'punct' && tok.value === '?') {
      if (!(next && next.value === ':')) {
        ternaryDepth++
      }
    } else if (tok.kind === 'punct' && tok.value === ':') {
      if (ternaryDepth > 0) {
        ternaryDepth--
      } else if (
        topCtx() !== 'objLiteral' &&
        prev &&
        (prev.kind === 'ident' || prev.value === ')' || prev.value === '?')
      ) {
        inTypeAnnotation = true
        typeAngleDepth = 0
        typeExpectsArrow = next?.value === '('
      }
    } else if (inTypeAnnotation && tok.kind === 'punct') {
      if (tok.value === '<') typeAngleDepth++
      else if (tok.value === '>') typeAngleDepth = Math.max(0, typeAngleDepth - 1)
      else if (typeAngleDepth === 0 && topCtx() !== 'typeBlock') {
        if (tok.value === ';') {
          inTypeAlias = false
          inTypeAnnotation = false
          typeExpectsArrow = false
        } else if (tok.value === '=>' && !inTypeAlias) {
          if (typeExpectsArrow) {
            typeExpectsArrow = false
          } else {
            inTypeAnnotation = false
          }
        } else if (tok.value === '=' && !inTypeAlias) {
          inTypeAnnotation = false
          typeExpectsArrow = false
        } else if (tok.value === ',' || tok.value === ')') {
          if (!typeExpectsArrow) {
            inTypeAnnotation = false
          }
        }
      }
    }

    // Detect `import ... from 'node:...'` or bare built-ins when at statement top-level (braceDepth === 0)
    if (braceDepth === 0 && tok.kind === 'ident' && tok.value === 'import') {
      // Skip dynamic `import(...)`
      if (next && next.value === '(') continue

      let isTypeOnly = false
      let clauseStartIdx = i + 1
      if (tokens[clauseStartIdx]?.kind === 'ident' && tokens[clauseStartIdx].value === 'type') {
        isTypeOnly = true
      }

      // Scan forward until `string` specifier after `from` OR side-effect `import 'node:...'`
      let j = i + 1
      let specTok: Token | null = null
      let fromTokIdx = -1
      while (j < tokens.length) {
        const cur = tokens[j]
        if (cur.value === ';') break
        if (cur.kind === 'string' && (j === i + 1 || tokens[j - 1]?.value === 'from')) {
          specTok = cur
          if (tokens[j - 1]?.value === 'from') fromTokIdx = j - 1
          j++
          if (tokens[j]?.value === ';') j++
          break
        }
        j++
      }

      if (specTok) {
        const spec = unquote(specTok.value)
        const mapped = resolveNodeBuiltinMapping(spec)
        if (mapped) {
          const endOffset = tokens[j - 1].end
          const statementText = text.slice(tok.start, endOffset)
          const clauseText =
            fromTokIdx > i + 1
              ? text.slice(tokens[i + 1].start, tokens[fromTokIdx].start).trim()
              : ''
          const bindings = clauseText ? parseImportBindings(clauseText) : []
          const pos = offsetToLineCol(lineStarts, tok.start)

          // Add namespace aliases / named bindings to bound set if an outer import already shadowed (n/a for host)
          imports.push({
            spec,
            capKey: mapped.capKey,
            capType: mapped.capType,
            nodeImport: mapped.nodeImport,
            namespaceImport: Boolean(mapped.namespaceImport),
            isTypeOnly,
            statementText,
            startOffset: tok.start,
            endOffset,
            line: pos.line,
            character: pos.character,
            bindings,
          })
          i = j - 1
          continue
        }
      }
    }

    // Detect `require('node:fs')` / `require('fs')`
    if (
      tok.kind === 'ident' &&
      tok.value === 'require' &&
      tokens[i + 1]?.value === '(' &&
      tokens[i + 2]?.kind === 'string' &&
      tokens[i + 3]?.value === ')'
    ) {
      const spec = unquote(tokens[i + 2].value)
      const mapped = resolveNodeBuiltinMapping(spec)
      if (mapped) {
        const endOffset = tokens[i + 3].end
        const pos = offsetToLineCol(lineStarts, tok.start)
        requires.push({
          spec,
          capKey: mapped.capKey,
          capType: mapped.capType,
          nodeImport: mapped.nodeImport,
          startOffset: tok.start,
          endOffset,
          line: pos.line,
          character: pos.character,
        })
      }
    }

    // Detect unbound ambient globals (`process`, `Buffer`, `__dirname`, `__filename`)
    if (
      inTypeBlockDepth < 0 &&
      !inTypeAnnotation &&
      tok.kind === 'ident' &&
      AMBIENT_SET.has(tok.value)
    ) {
      const name = tok.value as AmbientHostGlobalName
      if (boundGlobals.has(name)) continue
      if (prev && (prev.value === '.' || prev.value === '?.')) continue
      if (prev && (prev.value === 'as' || prev.value === 'satisfies')) continue
      // Skip object property key `{ process: foo }`
      if (next && next.value === ':' && ternaryDepth === 0) continue

      const pos = offsetToLineCol(lineStarts, tok.start)

      let byteLengthFix: HostGlobalMatch['byteLengthFix']
      if (
        name === 'Buffer' &&
        next &&
        next.value === '.' &&
        tokens[i + 2]?.value === 'byteLength' &&
        tokens[i + 3]?.value === '('
      ) {
        // Scan balanced parens for single argument
        let pDepth = 0
        let bDepth = 0
        let brDepth = 0
        let commaFound = false
        let closeParenTokIdx = -1
        for (let k = i + 3; k < tokens.length; k++) {
          const tv = tokens[k].value
          if (tv === '(') pDepth++
          else if (tv === ')') {
            pDepth--
            if (pDepth === 0) {
              closeParenTokIdx = k
              break
            }
          } else if (tv === '{') bDepth++
          else if (tv === '}') bDepth--
          else if (tv === '[') brDepth++
          else if (tv === ']') brDepth--
          else if (tv === ',' && pDepth === 1 && bDepth === 0 && brDepth === 0) {
            commaFound = true
          }
        }
        if (!commaFound && closeParenTokIdx > i + 3) {
          const argStart = tokens[i + 3].end
          const argEnd = tokens[closeParenTokIdx].start
          const argText = text.slice(argStart, argEnd).trim()
          if (argText.length > 0) {
            byteLengthFix = {
              startOffset: tok.start,
              endOffset: tokens[closeParenTokIdx].end,
              replacement: `new TextEncoder().encode(${argText}).byteLength`,
            }
          }
        }
      }

      globals.push({
        name,
        capType: AMBIENT_GLOBAL_TYPES[name],
        startOffset: tok.start,
        endOffset: tok.end,
        line: pos.line,
        character: pos.character,
        byteLengthFix,
      })
    }
  }

  return { imports, requires, globals, boundGlobals }
}

function fileBaseToPascalName(filePath?: string): string {
  if (!filePath) return 'CapabilityModule'
  const unified = filePath.replace(/\\/g, '/')
  const base = unified.slice(unified.lastIndexOf('/') + 1).replace(/\.(mts|ts|mjs|js|stealify)$/i, '')
  const words = base
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')
  if (!words) return 'CapabilityModule'
  return /^[0-9]/.test(words) ? `Module${words}` : words
}

function posixRelative(fromDir: string, toFile: string): string {
  const fromParts = fromDir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  const toParts = toFile.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  let common = 0
  while (common < fromParts.length && common < toParts.length && fromParts[common].toLowerCase() === toParts[common].toLowerCase()) {
    common++
  }
  const ups = Array(fromParts.length - common).fill('..')
  const rest = toParts.slice(common)
  const rel = [...ups, ...rest].join('/')
  return rel.startsWith('.') ? rel : `./${rel}`
}

function inferCapabilitiesImportPath(filePath?: string, explicit?: string): string {
  if (explicit) return explicit
  if (!filePath) return '@awesome-os/sections/drivers/capabilities-like.mts'
  const norm = filePath.replace(/\\/g, '/')
  const anchors = ['/sections/', '/intersections/', '/examples/', '/repository/', '/packages/', '/e2e/']
  for (const anchor of anchors) {
    const idx = norm.indexOf(anchor)
    if (idx >= 0) {
      const relFile = norm.slice(idx + 1)
      const dirParts = relFile.split('/')
      dirParts.pop()
      return posixRelative(dirParts.join('/'), 'sections/drivers/capabilities-like.mts')
    }
  }
  // Check relative paths without leading slash (e.g. "repository/awesome-os.com/serve.mts")
  for (const anchor of anchors) {
    const trimmed = anchor.slice(1)
    if (norm.startsWith(trimmed)) {
      const dirParts = norm.split('/')
      dirParts.pop()
      return posixRelative(dirParts.join('/'), 'sections/drivers/capabilities-like.mts')
    }
  }
  return '@awesome-os/sections/drivers/capabilities-like.mts'
}

interface RangeSpan {
  readonly start: number
  readonly end: number
}

function skipBalancedBlock(text: string, openBracePos: number): number {
  let i = openBracePos
  let depth = 0
  while (i < text.length) {
    const c = text.charCodeAt(i)
    if (c === 39 || c === 34) {
      const q = c
      i++
      while (i < text.length) {
        if (text.charCodeAt(i) === 92) {
          i += 2
          continue
        }
        if (text.charCodeAt(i) === q) {
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === 47 && text.charCodeAt(i + 1) === 47) {
      while (i < text.length && text.charCodeAt(i) !== 10) i++
      continue
    }
    if (c === 47 && text.charCodeAt(i + 1) === 42) {
      i += 2
      while (i + 1 < text.length && !(text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47)) i++
      i += 2
      continue
    }
    if (c === 123) depth++
    else if (c === 125) {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return text.length
}

/**
 * Wraps an un-injected TypeScript/JavaScript module in a Rollup-IIFE-style
 * capability factory `export const create<Name> = (caps: <Name>Capabilities) => { ... }`
 * so it passes B8G012/B8G013 and compiles under `"types": []`.
 */
export function refactorToCapabilityIife(
  sourceText: string,
  options: CapabilityRefactorOptions = {}
): CapabilityRefactorResult {
  const pascalName = fileBaseToPascalName(options.filePath)
  const factoryName = options.factoryName ?? `create${pascalName}`
  const capabilitiesInterfaceName = `${pascalName}Capabilities`

  const coupling = scanHostCoupling(sourceText)
  if (coupling.imports.length === 0 && coupling.requires.length === 0 && coupling.globals.length === 0) {
    return {
      changed: false,
      code: sourceText,
      factoryName,
      capabilitiesInterfaceName,
      requiredCaps: [],
      exportedValues: [],
      exportedTypes: [],
      hadShebang: sourceText.startsWith('#!'),
    }
  }

  let working = sourceText
  let hadShebang = false
  if (working.startsWith('#!')) {
    hadShebang = true
    const nl = working.indexOf('\n')
    working = nl >= 0 ? working.slice(nl + 1) : ''
  }

  // Re-scan after shebang removal so byte offsets match `working`
  const report = scanHostCoupling(working)
  const requiredCapsMap = new Map<string, RequiredCapabilitySpec>()
  for (const imp of report.imports) {
    if (!requiredCapsMap.has(imp.capKey)) {
      requiredCapsMap.set(imp.capKey, {
        key: imp.capKey,
        typeName: imp.capType,
        nodeImport: imp.nodeImport,
        namespaceImport: imp.namespaceImport,
      })
    }
  }
  for (const req of report.requires) {
    if (!requiredCapsMap.has(req.capKey)) {
      requiredCapsMap.set(req.capKey, {
        key: req.capKey,
        typeName: req.capType,
        nodeImport: req.nodeImport,
      })
    }
  }
  for (const g of report.globals) {
    if (!requiredCapsMap.has(g.name)) {
      requiredCapsMap.set(g.name, {
        key: g.name,
        typeName: AMBIENT_GLOBAL_TYPES[g.name],
        optional: g.name !== 'process',
      })
    }
  }

  // Collect all top-level imports (non-node imports preserved, node imports stripped)
  const nonNodeImports: string[] = []
  const removals: RangeSpan[] = []

  for (const imp of report.imports) {
    let end = imp.endOffset
    while (end < working.length && (working[end] === ' ' || working[end] === '\t')) end++
    if (working[end] === '\r') end++
    if (working[end] === '\n') end++
    removals.push({ start: imp.startOffset, end })
  }

  // Extract non-node top-level imports cleanly via statement scan at braceDepth === 0
  const nonNodeImpRe = /^[ \t]*import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+|)['"]([^'"]+)['"]\s*;?\r?\n?/gm
  let nm: RegExpExecArray | null
  while ((nm = nonNodeImpRe.exec(working)) !== null) {
    const spec = nm[1]
    if (resolveNodeBuiltinMapping(spec)) continue
    // Verify it starts at brace depth 0 by counting '{' vs '}' before nm.index
    const prefix = working.slice(0, nm.index)
    const opens = (prefix.match(/\{/g) ?? []).length
    const closes = (prefix.match(/\}/g) ?? []).length
    if (opens !== closes) continue
    nonNodeImports.push(nm[0].trimEnd())
    removals.push({ start: nm.index, end: nm.index + nm[0].length })
  }

  // Extract top-level `export interface` and `export type` blocks to hoist above the factory
  const hoistedTypeBlocks: string[] = []
  const exportedTypes: string[] = []
  const typeExportRe = /^[ \t]*export\s+(interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm
  let tm: RegExpExecArray | null
  while ((tm = typeExportRe.exec(working)) !== null) {
    const before = working.slice(0, tm.index)
    const opens = (before.match(/\{/g) ?? []).length
    const closes = (before.match(/\}/g) ?? []).length
    if (opens !== closes) continue

    exportedTypes.push(tm[2])
    let endIdx = tm.index + tm[0].length
    if (tm[1] === 'interface') {
      const bracePos = working.indexOf('{', endIdx)
      if (bracePos >= 0) {
        endIdx = skipBalancedBlock(working, bracePos)
      }
    } else {
      // `export type Foo = ...` up to ';' or balanced '{...}' / line end
      const eqPos = working.indexOf('=', endIdx)
      if (eqPos >= 0) {
        let p = eqPos + 1
        while (p < working.length && (working[p] === ' ' || working[p] === '\t')) p++
        if (working[p] === '{') {
          endIdx = skipBalancedBlock(working, p)
        } else {
          const nl = working.indexOf('\n', p)
          const semi = working.indexOf(';', p)
          endIdx = semi >= 0 && (nl < 0 || semi < nl) ? semi + 1 : nl >= 0 ? nl : working.length
        }
      }
    }
    if (working[endIdx] === ';') endIdx++
    while (endIdx < working.length && (working[endIdx] === '\r' || working[endIdx] === '\n')) endIdx++
    hoistedTypeBlocks.push(working.slice(tm.index, endIdx).trimEnd())
    removals.push({ start: tm.index, end: endIdx })
  }

  // Remove collected spans from `working` in descending offset order
  const sortedRemovals = [...removals].sort((a, b) => b.start - a.start)
  let body = working
  let lastStart = body.length + 1
  for (const r of sortedRemovals) {
    if (r.end > lastStart) continue
    body = body.slice(0, r.start) + body.slice(r.end)
    lastStart = r.start
  }

  // Replace any `require('node:...')` with `caps.<capKey>` inside body
  for (const req of report.requires) {
    const litRe = new RegExp(`require\\s*\\(\\s*['"]${req.spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\)`, 'g')
    body = body.replace(litRe, `caps.${req.capKey}`)
  }

  // Transform remaining top-level `export` declarations inside `body`
  const exportedValues: string[] = []
  const returnPairs: string[] = []
  let hasDefaultValue = false

  const bodyLines = body.split(/\r?\n/)
  const transformedLines: string[] = []
  let lineDepth = 0

  for (const line of bodyLines) {
    const trimmed = line.trim()
    if (lineDepth === 0) {
      let m: RegExpExecArray | null
      if ((m = /^export\s+(async\s+)?function(\*?)\s+([A-Za-z_$][A-Za-z0-9_$]*)(.*)$/.exec(trimmed))) {
        const asyncKw = m[1] ?? ''
        const star = m[2] ?? ''
        const name = m[3]
        exportedValues.push(name)
        returnPairs.push(name)
        transformedLines.push(`${asyncKw}function${star} ${name}${m[4]}`)
      } else if ((m = /^export\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)(.*)$/.exec(trimmed))) {
        const name = m[1]
        exportedValues.push(name)
        returnPairs.push(name)
        transformedLines.push(`class ${name}${m[2]}`)
      } else if ((m = /^export\s+(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)(.*)$/.exec(trimmed))) {
        const declKw = m[1]
        const name = m[2]
        exportedValues.push(name)
        returnPairs.push(name)
        transformedLines.push(`${declKw} ${name}${m[3]}`)
      } else if ((m = /^export\s+default\s+([\s\S]+)$/.exec(trimmed))) {
        hasDefaultValue = true
        returnPairs.push('default: __defaultExport')
        transformedLines.push(`const __defaultExport = ${m[1]}`)
      } else if ((m = /^export\s*\{([^}]+)\}\s*;?$/.exec(trimmed)) && !trimmed.includes(' from ')) {
        for (const item of m[1].split(',')) {
          const cleanItem = item.trim()
          if (!cleanItem || cleanItem.startsWith('type ')) continue
          const asMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(cleanItem)
          if (asMatch) {
            const local = asMatch[1]
            const exported = asMatch[2] ?? local
            exportedValues.push(exported)
            returnPairs.push(exported === local ? local : `${exported}: ${local}`)
          }
        }
        // Strip export-only line
      } else {
        transformedLines.push(line)
      }
    } else {
      transformedLines.push(line)
    }

    // Track coarse brace depth across line
    for (let k = 0; k < line.length; k++) {
      if (line[k] === '{') lineDepth++
      else if (line[k] === '}') lineDepth = Math.max(0, lineDepth - 1)
    }
  }

  // Build prologue bindings for stripped node:* imports & ambient host globals
  const capBindings: string[] = []
  const boundLocals = new Set<string>()
  const boundFromCapKeys = new Set<string>()

  for (const imp of report.imports) {
    if (imp.isTypeOnly) continue
    for (const b of imp.bindings) {
      if (b.kind === 'default' || b.kind === 'namespace') {
        if (!boundLocals.has(b.localName)) {
          capBindings.push(`  const ${b.localName} = caps.${imp.capKey}`)
          boundLocals.add(b.localName)
          boundFromCapKeys.add(imp.capKey)
        }
      } else if (b.kind === 'named' && b.importedName) {
        if (!boundLocals.has(b.localName)) {
          const propExpr =
            b.importedName === b.localName
              ? `const { ${b.localName} } = caps.${imp.capKey}`
              : `const { ${b.importedName}: ${b.localName} } = caps.${imp.capKey}`
          capBindings.push(`  ${propExpr}`)
          boundLocals.add(b.localName)
          boundFromCapKeys.add(imp.capKey)
        }
      }
    }
  }

  for (const g of report.globals) {
    if (boundLocals.has(g.name)) continue
    boundLocals.add(g.name)
    if (g.name === 'Buffer') {
      capBindings.push(`  const Buffer = caps.Buffer ?? PortableBuffer`)
    } else if (g.name === '__dirname') {
      capBindings.push(`  const __dirname = caps.__dirname ?? '.'`)
    } else if (g.name === '__filename') {
      capBindings.push(`  const __filename = caps.__filename ?? '${(options.filePath ?? 'module.mts').replace(/\\/g, '/').split('/').pop()}'`)
    } else {
      capBindings.push(`  const ${g.name} = caps.${g.name}`)
    }
  }

  // Prepare capabilities-like import list
  const typeImportNames = new Set<string>()
  const valueImportNames = new Set<string>()
  for (const spec of requiredCapsMap.values()) {
    if (spec.typeName.endsWith('Like')) {
      typeImportNames.add(spec.typeName)
    }
  }
  if (requiredCapsMap.has('Buffer')) {
    valueImportNames.add('PortableBuffer')
  }

  const capsImportPath = inferCapabilitiesImportPath(options.filePath, options.capabilitiesImportPath)
  const capImportItems: string[] = [
    ...Array.from(valueImportNames).sort(),
    ...Array.from(typeImportNames)
      .sort()
      .map((t) => `type ${t}`),
  ]

  const sectionsOut: string[] = []
  if (nonNodeImports.length > 0) {
    sectionsOut.push(nonNodeImports.join('\n'))
  }
  if (capImportItems.length > 0) {
    sectionsOut.push(`import { ${capImportItems.join(', ')} } from '${capsImportPath}'`)
  }
  if (hoistedTypeBlocks.length > 0) {
    sectionsOut.push(hoistedTypeBlocks.join('\n\n'))
  }

  const interfaceFields = Array.from(requiredCapsMap.values()).map(
    (spec) => `  readonly ${spec.key}${spec.optional ? '?' : ''}: ${spec.typeName}`
  )
  sectionsOut.push(
    `export interface ${capabilitiesInterfaceName} {\n${interfaceFields.join('\n')}\n}`
  )

  const cleanedBody = transformedLines
    .join('\n')
    .replace(/^\s*\n+/, '')
    .replace(/\s+$/, '')

  const indentedBody = cleanedBody
    ? cleanedBody
        .split('\n')
        .map((l) => (l.trim().length > 0 ? `  ${l}` : ''))
        .join('\n')
    : ''

  const uniqueReturnPairs = Array.from(new Set(returnPairs))
  const returnBlock =
    uniqueReturnPairs.length > 0
      ? `  return {\n${uniqueReturnPairs.map((p) => `    ${p},`).join('\n')}\n  }`
      : '  return {}'

  const factoryLines = [
    `export const ${factoryName} = (caps: ${capabilitiesInterfaceName}) => {`,
    ...capBindings,
    ...(capBindings.length > 0 && indentedBody ? [''] : []),
    ...(indentedBody ? [indentedBody, ''] : []),
    returnBlock,
    '}',
    '',
    `export default ${factoryName}`,
  ]
  if (hasDefaultValue) {
    exportedValues.push('default')
  }

  sectionsOut.push(factoryLines.join('\n'))

  return {
    changed: true,
    code: `${sectionsOut.join('\n\n')}\n`,
    factoryName,
    capabilitiesInterfaceName,
    requiredCaps: Array.from(requiredCapsMap.values()),
    exportedValues: Array.from(new Set(exportedValues)),
    exportedTypes: Array.from(new Set(exportedTypes)),
    hadShebang,
  }
}

/**
 * Generates the companion `<stem>.host.mts` outer Node host binder for a
 * capability-refactored module.
 */
export function emitCapabilityHostAdapter(
  refactorResult: CapabilityRefactorResult,
  moduleFilePath: string
): { hostFilePath: string; hostCode: string } {
  const norm = moduleFilePath.replace(/\\/g, '/')
  const slashIdx = norm.lastIndexOf('/')
  const dir = slashIdx >= 0 ? norm.slice(0, slashIdx) : '.'
  const baseName = slashIdx >= 0 ? norm.slice(slashIdx + 1) : norm
  const dotIdx = baseName.lastIndexOf('.')
  const stem = dotIdx >= 0 ? baseName.slice(0, dotIdx) : baseName
  const ext = dotIdx >= 0 ? baseName.slice(dotIdx) : '.mts'
  const hostBase = `${stem}.host${ext}`
  const hostFilePath = dir === '.' ? hostBase : `${dir}/${hostBase}`

  const nodeImports: string[] = []
  const capAssignments: string[] = []

  for (const cap of refactorResult.requiredCaps) {
    if (cap.nodeImport) {
      const importVar = cap.key
      if (cap.namespaceImport) {
        nodeImports.push(`import * as ${importVar} from '${cap.nodeImport}'`)
      } else {
        nodeImports.push(`import ${importVar} from '${cap.nodeImport}'`)
      }
      capAssignments.push(`  ${cap.key}: ${importVar},`)
    } else if (cap.key === 'process') {
      capAssignments.push('  process,')
    } else if (cap.key === 'Buffer') {
      capAssignments.push('  Buffer,')
    } else if (cap.key === '__dirname') {
      if (!nodeImports.some((l) => l.includes("'node:path'"))) nodeImports.push(`import path from 'node:path'`)
      if (!nodeImports.some((l) => l.includes("'node:url'"))) nodeImports.push(`import * as url from 'node:url'`)
      capAssignments.push(`  __dirname: path.dirname(url.fileURLToPath(import.meta.url)),`)
    } else if (cap.key === '__filename') {
      if (!nodeImports.some((l) => l.includes("'node:url'"))) nodeImports.push(`import * as url from 'node:url'`)
      capAssignments.push(`  __filename: url.fileURLToPath(import.meta.url),`)
    }
  }

  const lines: string[] = []
  if (refactorResult.hadShebang) {
    lines.push('#!/usr/bin/env node')
  }
  lines.push(
    '/**',
    ` * @file ${hostBase}`,
    ` * @description Outer Node.js host capability binder for \`./${baseName}\`.`,
    ' */',
    ''
  )

  if (nodeImports.length > 0) {
    lines.push(...nodeImports)
  }

  const moduleImports = [refactorResult.factoryName]
  for (const t of refactorResult.exportedTypes) {
    moduleImports.push(`type ${t}`)
  }
  lines.push(`import { ${moduleImports.join(', ')} } from './${baseName}'`)
  lines.push('')

  if (refactorResult.exportedTypes.length > 0) {
    lines.push(`export type { ${refactorResult.exportedTypes.join(', ')} } from './${baseName}'`)
    lines.push('')
  }

  lines.push(`export const hostModule = ${refactorResult.factoryName}({`)
  lines.push(...capAssignments)
  lines.push('})')
  lines.push('')

  const valueReExports = refactorResult.exportedValues.filter((v) => v !== 'default')
  if (valueReExports.length > 0) {
    lines.push(`export const { ${valueReExports.join(', ')} } = hostModule`)
  }
  if (refactorResult.exportedValues.includes('default')) {
    lines.push('export default hostModule.default')
  } else {
    lines.push('export default hostModule')
  }

  return {
    hostFilePath,
    hostCode: `${lines.join('\n')}\n`,
  }
}
