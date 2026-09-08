# Using PDF Workbench

## Included tools

| Workspace | Available operations |
| --- | --- |
| Organize | Merge PDFs; insert PDF pages; extract, delete, reorder, duplicate, and rotate selected pages; insert blank pages; crop; resize; split explicit page groups. |
| Convert | Render PDF pages to PNG or JPEG with resolution, JPEG quality, and PNG transparency choices; create PDF pages from PNG/JPEG; extract selectable text to TXT. |
| Optimize | Five compression presets with measured input/output size, changed image counts, and actual savings or growth. |
| Workspace | Single-page and grid views; lazy thumbnails; selectable text and search; light/dark/system themes; undo/redo; saved projects; previous-session recovery; cancellable processing. |

**Merge and insert:** opening several PDFs builds one arrangement. **Insert or merge PDF** adds pages after the active page. Image imports similarly insert after the active page. A blank page uses the paper dimensions currently shown under Resize.

**Split:** enter groups separated by semicolons, such as `1-2; 3,5; 4`. This produces three files using the current page order. Ranges use one-based page numbers; overlapping groups are allowed. Extract exports selected pages in their current order.

**Crop:** enter margins in points from the original, unrotated page edges. Cropping changes the visible boundary; hidden text and images remain recoverable. It is not redaction.

**Resize:** choose A4, Letter, A3, Legal, or custom dimensions. **Fit** preserves content proportions. **Stretch** scales width and height independently. **Page bounds only** keeps the original content origin and size; changing the paper can hide or reveal content. Anchor and margin apply to content-scaling modes. There are 72 points per inch. Apply the settings and inspect the live preview before exporting.

**Images and text:** image export renders the chosen PDF pages; page organization itself never rasterizes PDFs. JPEG exports have a white background. PNG transparency applies only to unpainted areas. TXT extraction uses existing selectable text, without OCR; reading order can differ from the visual layout. Input formats are PDF, PNG, and JPEG. Office documents, CSV/table conversion, and other image formats are not supported in this release.

**Optimization:** choose Quick lossless, Thorough lossless (default), or an explicitly lossy image preset at JPEG quality 90, 75, or 50. Lossless keeps image pixels intact. Image presets recompress eligible RGB/gray images, including existing JPEGs, while retaining pixel dimensions, selectable text and vectors. Special image formats or transparency may require a lossless choice. No pages are rasterized. Already-efficient PDFs may grow. The app reports measured bytes and changed image objects and always exports a copy. The preview shows the current PDF until you choose Reopen exported PDF. Compare presets from the original input to avoid cumulative JPEG loss. See the README Compression Lab exercise for measured examples.

## Selection and shortcuts

| Action | Shortcut |
| --- | --- |
| Open PDF | ⌘O on Mac / Ctrl+O on Windows |
| Save project as a new file | ⌘S / Ctrl+S |
| Undo / redo | ⌘Z / ⌘⇧Z; Ctrl+Z / Ctrl+Shift+Z |
| Select all pages | ⌘A / Ctrl+A outside text inputs |
| Select a range | Shift-click a thumbnail |
| Add/remove individual selections | ⌘-click / Ctrl-click |
| Move selected pages | Alt+↑ / Alt+↓ |
| Delete selected pages | Delete or Backspace outside text inputs; at least one page must remain |
| Inspect a page from the grid | Double-click its thumbnail |

Search finds pages containing selectable text and highlights matching text spans. An empty image/text export range uses the selected pages. Enter a range such as `1-3, 5` to override that selection.

