Vendored from `@browsermt/bergamot-translator` 0.4.9 (MPL-2.0, https://github.com/browsermt/bergamot-translator).
Bergamot is the offline translation engine used by Firefox. `worker/package.json` marks the worker scripts
as CommonJS so they run under Node/Electron worker threads.

Local patch: `worker/translator-worker.js` builds file URLs with `pathToFileURL`/`fileURLToPath` so model and
WASM paths work on Windows (the original produced `D:\D:\...`).
