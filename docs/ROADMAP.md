# Educational development roadmap

Version 0.1.5 adds five tested compression presets to the local page-workflow preview and rebuilt installers. The following work is deliberately unfinished.

1. Validate installation and the full document workflow in an isolated Windows x64 environment: WebView2 setup, DLL loading, fonts, themes, native dialogs, cancellation, export/reopen, and uninstall.
2. Choose the application license; arrange authorized Developer ID signing/notarization for Mac and code signing for Windows; review dependency notices before general public distribution.
3. Expand generated regression PDFs for annotations, accessibility tags, links, destinations, and page geometry. Preserve more structures through page reorganization only when remapping can be verified.
4. Improve project portability with explicit source relinking, project archive export, and documented recovery/temporary-file cleanup.
5. Measure first-page rendering, thumbnail latency, memory, and exports on larger documents and both platforms before performance changes.
6. Explore opt-in image downsampling and a before/after compression preview, with explicit legibility, transparency and color-management checks. Test more scans and complex image formats before widening the current JPEG validation exception.
7. Evaluate advanced text editing, Office conversion, OCR, true redaction, and certificate signing as separate projects with explicit accuracy, licensing, preservation, and verification requirements.

No release date or complete PDF fidelity is promised for these milestones. Unsupported operations must remain unavailable with an understandable explanation.
