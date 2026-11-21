; The Windows installer: Inno Setup puts the one-file program into the user's own
; Programs folder, with a Start-menu entry, an optional desktop shortcut and an
; uninstaller. No administrator is needed, because it installs for this user only.
;
;   pip install ".[build]" && sh packaging/build.sh
;   python packaging/make_icons.py build/icons
;   iscc /DAppVersion=0.2.12 packaging/windows_setup.iss      -> dist/scilog-viewer-setup-windows-x86_64.exe

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{8F6A2E54-3C1B-4D27-9A7E-5C0B1D2E3F40}
AppName=SciLog viewer
AppVersion={#AppVersion}
AppVerName=SciLog viewer {#AppVersion}
AppPublisher=SciLog viewer
AppPublisherURL=https://github.com/swissfel/scilog-viewer
DefaultDirName={autopf}\SciLog viewer
DefaultGroupName=SciLog viewer
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=scilog-viewer-setup-windows-x86_64
SetupIconFile=..\build\icons\scilog-viewer.ico
UninstallDisplayIcon={app}\scilog-viewer.exe
UninstallDisplayName=SciLog viewer
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Put a shortcut on the desktop"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\dist\scilog-viewer.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\SciLog viewer"; Filename: "{app}\scilog-viewer.exe"
Name: "{autodesktop}\SciLog viewer"; Filename: "{app}\scilog-viewer.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\scilog-viewer.exe"; Description: "Start the SciLog viewer"; Flags: nowait postinstall skipifsilent
