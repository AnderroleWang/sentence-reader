# Third-party notices

Original Sentence Reader code is licensed under the MIT License; see `LICENSE`. This distribution also includes the following third-party components. Their original licenses remain applicable; the project MIT license does not replace them.

| Component | Version / source | Included files | License |
| --- | --- | --- | --- |
| Mozilla PDF.js | 4.10.38, https://github.com/mozilla/pdf.js | `vendor/pdf.mjs`, `vendor/pdf.worker.mjs`, `vendor/pdf_viewer.css` | Apache-2.0; see `vendor/PDFJS-LICENSE` and source headers |
| Liberation fonts | Distributed with PDF.js 4.10.38 | `vendor/standard_fonts/LiberationSans-*.ttf` | SIL Open Font License 1.1; see `vendor/standard_fonts/LICENSE_LIBERATION` |
| Foxit standard fonts | Distributed with PDF.js 4.10.38 | `vendor/standard_fonts/Foxit*.pfb` | See `vendor/standard_fonts/LICENSE_FOXIT` |
| CPython, Windows portable package only | Official Python 3.12.10 embeddable distribution, https://www.python.org/downloads/release/python-31210/ | `runtime/` | Python Software Foundation license and bundled dependency notices; see `runtime/LICENSE.txt` |

The demo PDF and bilingual text in `examples/layout-demo.句读.json` were created for this reader. Real research papers, user archives, API credentials, model weights, and upstream translation executables are not part of the distribution.

This reader independently implements adapters for documented SideBySide and Zotero Bilingual mapping formats. BabelDOC, PDF2zh, Zotero plugins, SideBySide application code, GitHub CLI and the development environment are not redistributed. See `UPSTREAM.md` for research and compatibility details.
