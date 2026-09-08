# Architecture and preservation boundary

## Decision, 2026-09-08

Keep the proposed Tauri 2 + React/TypeScript architecture. The Apple Silicon native qpdf sidecar compiles with static qpdf/libjpeg and system zlib, libc++ and libSystem only. PDF.js runs in WKWebView with a dedicated PDF worker; pdf-lib geometry and image assembly run in a separate cancellable worker. No runtime Node, Python, qpdf installation or account is required. PDF.js fonts/CMaps/WASM and dependency notices are bundled for offline use.

`src/model.ts` owns schema 1 page plans and operation snapshots. Each source has a stable ID, original path, SHA-256, byte size and preflight inventory. Each page references a source page or explicit blank size, then records rotation, crop margins and resize settings. History is bounded to 100 snapshots. Image imports record original image hashes and embedding settings. Saved projects retain generated input PDFs in project-local `projects/assets`.

`src/adapters/workbench.ts` is the narrow client workflow: selected native sources, bounded 128 KiB reads/writes, SHA-256 verification, PDF.js viewing/conversion, worker orchestration, export receipts. Native calls never expose an arbitrary shell. Maximum file/output is 50 MiB; maximum page count is 1,000. Image export caps one canvas at 40 megapixels and 600 DPI. One native job runs at a time; thumbnails are lazily rendered and offscreen canvas storage is released.

`src-tauri/src/lib.rs` owns file dialogs, source authorization, qpdf preflight, cancellable subprocesses (180-second limit), output staging, validation, no-clobber commits, receipts and project source validation. External argument arrays avoid shell interpolation. qpdf warnings reject rather than silently repair the document. Source SHA-256 is rechecked before structural operations and output commit.

The planner returns untouched source data for an unchanged complete document; qpdf assembles/rotates pages; only crop or resize enters pdf-lib. Blank/image PDFs use pdf-lib. PDF.js PNG/JPEG and TXT exports are explicit conversions. Structural editing never rasterizes pages. qpdf preserves the primary source's basic Info metadata; secondary-source document metadata does not become the merged document's metadata.

## Supported preservation scope

Preflight identifies document structures separately from operation capabilities. Source.editable permits unrestricted page assembly/pdf-lib geometry only when no protected features are detected. Source.preserveDocument permits a complete, unchanged page tree with selected rotation/CropBox updates and structural optimization for allowlisted publisher features. An unchanged byte-copy export does not require either capability. Capabilities are recomputed natively when a project is restored, including schema 1 files saved by older builds.

The preservation adapter uses whole-document qpdf JSON updates, never page assembly. It compares persistent trailer roots, paired indirect references in both directions, dictionary/array values, and generalized-decoded stream data. Exact expected geometry is inserted into the comparison model. Serialization-only trailer fields such as object offsets and file IDs are outside semantic comparison. Comparison/report limits, unknown active structures, unsupported units, or unexpected changes reject the operation. A destination-array OpenAction is classified as an opening view, not JavaScript.

An optional editing-copy path is limited to supported document features and invisible Link annotations. After explicit UI acknowledgement, it removes the disclosed annotation/tag/navigation/metadata structures, uses --empty page assembly, then verifies effective geometry, page content/resources and decoded streams. The output must pass feature-free preflight. Provenance records source hashes, authoritative removals, and engine settings. This is a deliberate accessibility/navigation tradeoff, not an arbitrary-feature preservation claim. The README describes the user-visible removal disclosure. The [qpdf page-selection documentation](https://qpdf.readthedocs.io/en/stable/cli.html#page-selection) describes why unqualified page assembly is insufficient for document-level data.

Crop changes CropBox in original unrotated MediaBox coordinates; it does not redact. Fit/stretch clips to the previous visible crop before scaling to prevent hidden margins reappearing unintentionally. Bounds-only resize changes paper/CropBox at the fixed original origin, without scaling; it can hide or reveal existing content. Fit keeps aspect ratio; stretch does not. Geometry rejects nonzero MediaBox origins and nonstandard UserUnit; resize rejects explicit production TrimBox/BleedBox/ArtBox rather than discarding them.

## Platform and filesystem behavior

Development tooling and caches use a dedicated PDFWorkbench workspace. exFAT can expose AppleDouble metadata as files; glob filters in Vitest/TypeScript/CMake and the local tauri-utils patch exclude that metadata. Installed builds use platform per-user application storage unless an explicit workspace is configured.

On filesystems supporting it, output uses a validated temporary file and atomic no-clobber commit. exFAT lacks the needed rename/hardlink primitive: the fallback exclusively creates the new path and copies validated data, syncs, and removes its own partial file on handled failure/cancellation. The report labels the non-atomic commit. A power loss can leave a partial new output on exFAT; it cannot replace an existing original. PDF and recipe cannot be committed as one transaction; receipt failure is reported after a successful PDF commit.

Temporary files are retained in this isolated workspace so unsaved session recovery can reference generated inputs; saved project assets are durable. No automatic updater, telemetry, cloud service or public hosting is configured. Webview settings/localStorage may use standard per-app OS storage; PDF processing scratch files use the configured workspace or the installed app’s per-user Workspace. PDF scripts are not executed; CSP forbids arbitrary remote connections, plugin objects and unsafe eval. PDF.js assets are local.

## Licensing

Core qpdf and PDF.js: Apache-2.0. pdf-lib: MIT. Tauri/React and other notices are bundled. Tauri's dependency graph includes file-scoped MPL-2.0 components; their full unchanged sources and license texts are retained in notices to meet the corresponding source obligations. No AGPL/commercial PDF engine or paid SDK was introduced. Signing and the application license decision remain pending before general distribution.

## Native feasibility findings

The packaged WKWebView exposed the upstream PDF.js ReadableStream async-iterator incompatibility during text extraction (issues [21557](https://github.com/mozilla/pdf.js/issues/21557) and [20973](https://github.com/mozilla/pdf.js/issues/20973)). The viewer uses PDF.js's official compatibility build and a small adapter consuming `streamTextContent().getReader()` explicitly. It changes neither PDF parsing nor document content. Regression tests simulate a stream without an async iterator. Canvas rendering remains visible if a particular text layer fails, with a specific notice; actual canvas failures disable PDF export until resolved.

Normal app startup retains timing measurements in memory and performs no project-drive writes before a file operation. Explicit benchmark runs enable `PDFWORKBENCH_BENCHMARK=1`. File operations run on background threads, including small staging writes, so macOS file-access consent cannot block the main UI thread. Final packaging strips only metadata from its generated copy, signs qpdf and the app locally ad hoc, verifies both seals, and retains all notices/sources in `Contents/Resources/THIRD-PARTY-NOTICES.zip`. The archive avoids exFAT cluster waste without omitting licenses or source obligations.

## Viewer dependency update

The local 0.1.2 build pins PDF.js 6.3.289. The final npm audit identified [GHSA-hq66-cqwq-w95j](https://github.com/advisories/GHSA-hq66-cqwq-w95j) in the previously tested viewer version. The application already omits PDF scripting/annotation managers and applies a restrictive CSP, matching the advisory mitigation, but the dependency was upgraded to a patched version before delivery. The public compatibility build and text stream reader remain. Resource cleanup now uses `PDFDocumentProxy.loadingTask.destroy()`, required by the new API. `npm audit` reports zero known JavaScript dependency vulnerabilities on 8 September 2026. This does not constitute an audit of all native dependencies. Native visual verification of this upgrade is captured in native screenshots.

## Optimization boundary (0.1.5)

`src/optimization.ts` defines the five UI choices. `src-tauri/src/optimization.rs` owns the native enum, fixed engine arguments and the narrow image exception. Export accepts an optional preset; ordinary single/batch exports pass no preset. Project schema 1 accepts optional versioned settings, and receipts record both the preset and resolved engine arguments.

Quick lossless packs objects and compresses streams at level 6. Thorough lossless also recompresses Flate at level 9. Image presets add qpdf image optimization, explicit JPEG quality 90/75/50, and keep inline images. Unreferenced page resource removal is disabled. There is no page rasterization, downsampling, metadata stripping, or font conversion in this path.

Both lossless paths use the existing exact reachable-graph comparison with generalized-decoded streams. Image paths use that same traversal with one explicit exception: a changed ordinary 8-bit DeviceRGB/DeviceGray image can have a new JPEG payload and filter. A bounded JPEG header parser verifies dimensions, 8-bit precision and component count, and qpdf's structural check decodes supported output streams. All other image dictionary entries still compare through the graph matcher. Changed masks, transparency, custom decoding, unsupported color spaces or dimensions fail closed. Each cloned shared image is checked; non-image reference aliases retain their strict checks. All non-image streams (including text operators, font programs, metadata and masks) remain exact. This checks a concrete structural claim; it is not a universal visual-fidelity proof.

The existing native job cancellation, timeout, source hash checks, staged verification, no-overwrite commit and output reopening apply to every preset. A failed comparison leaves no final export. The report counts actual changed output image objects and records no-image-change cases honestly. Per-image savings do not guarantee whole-file savings because encoding overhead and shared-object cloning can increase the total.
