# Windows installer components

The NSIS 3.11 installer includes its standard setup stub and plugins, with the applicable license texts in NSIS-3.11-COPYING.txt. The complete, unchanged matching NSIS source, including compression module source, is available at https://sourceforge.net/projects/nsis/files/NSIS%203/3.11/nsis-3.11-src.tar.bz2/download (SHA-256 19e72062676ebdc67c11dc032ba80b979cdbffd3886c60b04bb442cdd401ff4b).

The nsis_tauri_utils 0.5.3 plugin uses the accompanying MIT / Apache-2.0 licenses. Matching source: https://github.com/tauri-apps/nsis-tauri-utils/tree/nsis_tauri_utils-v0.5.3 . No NSIS or plugin source was changed for this application; the compiler was built with the matching VERSION=3.11 setting.

The qpdf Windows release supplies qpdf30.dll and Microsoft Visual C++ runtime DLLs. Those components retain their own copyright and redistribution terms; they are not covered by an application license. They must stay beside qpdf.exe. The Windows system libraries imported by these executables are supplied by Windows.
