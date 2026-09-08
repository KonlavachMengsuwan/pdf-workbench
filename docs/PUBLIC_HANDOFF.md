# Development handoff: 0.1.5 educational preview

Version 0.1.5 adds five real optimization presets: Quick lossless, Thorough lossless, and JPEG image qualities 90/75/50. Ordinary exports do not inherit a lossy setting. Optional versioned settings persist in schema 1 projects, and export receipts record exact qpdf arguments, actual sizes and changed image counts. See README.md for the full educational exercise, limits and measured results.

The image path permits only bounded JPEG payload/filter changes to eligible 8-bit RGB/gray images. Non-image graph comparisons stay strict. Changed transparency, masks, custom decoding and unsupported formats fail closed and recommend lossless. Native tests cover real exports, shared-image clones, grayscale, already-compressed JPEGs, zero-image cases, rejected transparency, cancellation and overwrite protection. No optimization path rasterizes pages or silently removes metadata.

Validation: 57 frontend tests, 21 native tests, 236 existing independent export checks and 315 optimization checks passed. The final Mac application opened the generated sample, rotated and undid a page change, exported Balanced compression and reopened it. Light/Dark screenshots use only original generated content. A separate source snapshot restored fresh npm dependencies and passed the frontend tests, formatting and build.

Mac arm64 DMG/PKG/app ZIP and Windows x64 NSIS installer were rebuilt. The Mac app is locally ad-hoc signed; installers are unsigned and not notarized. Windows was cross-built and inspected on macOS; Windows installation and runtime remain untested. No personal Windows PC or GitHub Actions execution was used. Platform builds must run sequentially in one checkout because both regenerate frontend assets.

The default app workspace remains per-user application data, with strict explicit PDFWORKBENCH_HOME behavior. The source snapshot has no working Git history, private documents, projects, receipts or old screenshots. Use scripts/prepare-sharing-package.py and its three-example PDF allowlist. Do not upload the complete development workspace.

Next: test Windows in an isolated environment; measure more scan/image/complex-color workloads; consider opt-in image downsampling with independent fidelity checks; add compression result comparison; select the application license and arrange authorized signing/notarization before general distribution. Preserve the existing editing-copy disclosures and page-structure restrictions.
