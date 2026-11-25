# stealifylang-vscode

MIT StealifyLang LSP, `stealify-lint` (`B8G001`–`B8G016` + `.stealify-rules` + governance `project-rules`), and Wave-2 TypeScript 6.0.3 extension for Awesome-OS **Code - OSS** and **Eclipse Theia**.

## Install & Usage

### 1-Command `.vsix` Install (Awesome-OS Code - OSS / Eclipse Theia / VS Code)

```powershell
gh release download -R awesome-os/stealifylang-vscode --pattern "*.vsix" --dir "$HOME/.b8g/cas/extensions" --clobber
```

Or download the `.vsix` from [`Releases`](https://github.com/awesome-os/stealifylang-vscode/releases/latest) and run `code-oss --install-extension <file>.vsix` (or install from Open VSX once published).

### Usage

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

- **Stealify: Fix All B8G Auto-Migratable Issues** (`stealifyLint.fixAll`)
- **Stealify: Audit Workspace Governance Project Rules** (`stealifyLint.auditWorkspace`)
- **Stealify: Switch to Wave-2 Fast TypeScript 6.0.3 (cas-v1)** (`stealify.useFastTypeScript`)
- **Stealify: Compile Active File to .b8e Container** (`stealify.compileToB8e`)
- **Stealify: Flush Pending Diagnostics** (`stealify.flushDiagnostics`)

Run tests locally (Node.js 22+):

```powershell
node --test test/*.test.mts
```

## Features

- **StealifyLang Grammar & Language Configuration**: Full `.stealify` TextMate grammar (`syntaxes/stealify.tmLanguage.json`) and bracket/folding rules (`language-configuration.json`) for `@defer`, `@placeholder`, `@loading`, `@error`, `@hydrate`, `@isolate`, `@disposable`, `@memo`, container lifecycles, and `B8gMemoryArena` primitives.
- **Zero-Dependency `--stdio` LSP (`src/lint/lint-cli.mts`)**: Live `B8G001`–`B8G016` diagnostics, Sub-Module Block CAS caching (`b8g-block-cas.mts`), one-click QuickFixes, Rollup-IIFE capability wrapper auto-refactoring (`capability-iife-refactor.mts`), hover docs, and `.stealify-rules` hot-reload.
- **Governance Project Rules (`src/rules/project-rules.mts`)**: Runs Awesome-OS erasable TypeScript, explicit ESM extension, zero-`npx`, zero-shell-script, `.mts` preference, and capability injection rules across any workspace.
- **Wave-2 Fast TypeScript 6.0.3 (`resolveFastTypeScriptPlan`)**: Resolves `typescript-6.0.3-programmable.tar.gz` directly from `awesome-os/b8g-ghost` `cas-v1` manifests so Code - OSS / Theia can switch `typescript.tsdk` to our 14.3x faster programmable compiler.
- **Zero Build Step**: 100% erasable TypeScript (`erasableSyntaxOnly: true`, `"type": "module"`, `"main": "./src/extension.mts"`).

## Commands

| Command | Description |
| :--- | :--- |
| `stealifyLint.fixAll` | Fix all auto-fixable B8G issues in the active document |
| `stealifyLint.auditWorkspace` | Run governance `project-rules` across workspace folders |
| `stealify.useFastTypeScript` | Resolve Wave-2 TypeScript 6.0.3 (`cas-v1`) for `typescript.tsdk` |
| `stealify.compileToB8e` | Compile active `.stealify` file to a `.b8e` container |
| `stealify.flushDiagnostics` | Flush pending batched diagnostics immediately |

## Testing

```bash
node --test test/stealifylang-vscode.test.mts
```

## License

[MIT](LICENSE)

## Quick Install & Run (Windows / Linux / macOS)

```sh
# Install / hydrate from v11 CAS via holo-pm
holo-pm install repository://github.com/awesome-os/stealifylang-vscode@main

# Or project & run directly via holo-project (0-byte hardlink)
holo-project "project://node/stealifylang-vscode?from=repository://github.com/awesome-os/stealifylang-vscode@main"
```
