# Version 0.1.5 validation

Executed on 8 September 2026 using an Apple Silicon Mac. Only generated educational fixtures are included in this repository. Windows execution remains untested.

| Check | Result | Scope |
|---|---|---|
| Vitest | 57 passed | Geometry, preservation policy, text reader, editing-copy workflow, source/history handling and cancellation. |
| Rust native tests | 21 passed | Real qpdf preflight/export, no-clobber commits, source hashes, project validation, semantic graph comparisons and editing-copy organization. Includes managed-storage initialization and strict missing-workspace behavior. |
| Independent export suite | 236 checks passed | Generated fixtures; pypdf inspection, decoded image/font comparisons and Poppler rendering. [Detailed results](results/validation.json). |
| Packaged app workflow | Passed | Open Compression Lab → rotate and undo → choose Balanced image compression → export a new PDF → reopen the saved result. |
| Independent native UI export validation | 24 checks passed | Actual final-app export compared with the native test output, verified receipt/hash/byte counts and independent rendering. [Detailed results](results/educational-workflow-0.1.5.json). |
| Optimization suite | 315 checks passed | Actual native exports for five presets across RGB/JPEG, grayscale and empty-page fixtures; pypdf text/font/geometry/navigation inspection, exact lossless pixels, lossy image measurements and Poppler rendering. [Detailed results](results/optimization-0.1.5.json). |
| Themes | Inspected and captured | Native macOS Light/Dark screenshots show all five presets with only the generated Compression Lab sample. |
| Mac archive/payload | 20 checks passed | Ad-hoc app signature; ZIP integrity; PKG payload inspection; DMG integrity and extracted app signature. |
| Windows build | Cross-build completed; 49 static checks passed | NSIS integrity, x64 PE architecture, engine/DLL hashes, license archive, and bundled/system imports. [Package report](results/windows-package-0.1.5.json). |
| Windows execution | **Not run** | Installer, application UI, WebView2 provisioning, offline workflow and uninstall need a Windows test environment. |
| Clean sharing snapshot | Passed frontend restore/build/checks | Separate source copy, fresh npm dependencies and generated fixtures; 57 tests, formatting and production frontend build passed. Existing verified qpdf sidecar reused. [Snapshot report](results/source-snapshot-0.1.5.json). |
| Formatting | Passed | Prettier source check. |

The example source SHA-256 remains unchanged after transformation. The balanced native export is 608,616 bytes versus 1,757,758 bytes input (65.4% smaller); this is not a general compression promise. All examples retain selectable text and vector content. Lossless exports had identical Poppler pixels; image presets deliberately changed image pixels. JPEG quality 90/75/50 produced distinct decreasing sizes on RGB and grayscale fixtures. Changed transparency was rejected without a final output; the lossless fallback passed. Cancellation, no-overwrite behavior, unknown preset/settings rejection, source hashes, and strict non-image graph validation were checked.

## Mac installer verification limits

The PKG and DMG were extracted and their application payloads compared with the release app. The final release app was launched from the dedicated workspace and used for the workflow above. No administrator installation into `/Applications` was performed. The DMG passed `hdiutil verify` and an independent 7-Zip integrity test. A native read-only mount attempt was denied by host permissions; inspection instead extracted the contents without mounting. Filesystem metadata streams were handled separately when checking the extracted app's signature.

The app is locally ad-hoc signed; the installers are unsigned and not notarized. These tests do not establish Gatekeeper acceptance of a downloaded copy on another Mac.

## Repeat the export checks

Generate the fixtures and run the frontend tests using the README commands. Then use a separately available Poppler renderer:

```sh
../tools/validation-python/bin/python tests/validate_exports.py --pdftoppm /absolute/path/to/pdftoppm
../tools/validation-python/bin/python tests/validate_optimization.py --pdftoppm /absolute/path/to/pdftoppm
```

The validator uses the project-local temporary directory and produces reports in `docs/results`. It does not download or inspect a personal document. Build/test logs and ordinary application receipts can contain local paths; review them before sharing.

## Known coverage gaps

These tests cover concrete fixtures and operations. They do not prove universal PDF fidelity, accessibility conformance, complete navigation remapping, digital signature validity or arbitrary damaged-file recovery. There has been no Windows UI or installation test, no Intel Mac test, no app-store review, and no general security audit. Large-document performance should be measured on each platform before optimization.
