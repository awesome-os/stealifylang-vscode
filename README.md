# stealifylang-vscode

MIT StealifyLang LSP, `stealify-lint` (`B8G001`–`B8G016` + `.stealify-rules` + governance `project-rules`), and Wave-2 TypeScript 6.0.3 extension for Awesome-OS **Code - OSS** and **Eclipse Theia**.

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
