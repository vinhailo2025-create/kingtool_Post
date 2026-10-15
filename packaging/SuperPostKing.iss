#define MyAppName "Super Post - King"
#define MyAppVersion "1.1.23"
#define MyAppPublisher "King Automation AI"
#define MyAppURL "https://kingautomationai.com"
#define MyAppExeName "Super Post - King.exe"

[Setup]
AppId={{3CF6A2EC-9908-4D29-9B7B-94A9296C207D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\King Automation AI\Super Post King
UsePreviousAppDir=no
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist\installer
OutputBaseFilename=Super-Post-King-Setup
SetupIconFile=..\public\assets\branding\super-post-king-logo.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}
VersionInfoVersion=1.1.23.0
CloseApplications=yes
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription=Super Post - King Installer
VersionInfoProductName={#MyAppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Tạo biểu tượng ngoài Desktop"; GroupDescription: "Biểu tượng bổ sung:"; Flags: unchecked

[Files]
Source: "..\dist\desktop_launcher.dist\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "prereqs\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: not WebView2Installed
Source: "prereqs\ChromeSetup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: not ChromeInstalled

[Dirs]
Name: "{localappdata}\King Automation AI\Super Post King\src\database"; Flags: uninsneveruninstall
Name: "{localappdata}\King Automation AI\Super Post King\src\chrome-profiles"; Flags: uninsneveruninstall
Name: "{localappdata}\King Automation AI\Super Post King\src\backups"; Flags: uninsneveruninstall
Name: "{localappdata}\King Automation AI\Super Post King\uploads"; Flags: uninsneveruninstall
Name: "{localappdata}\King Automation AI\Super Post King\webview"; Flags: uninsneveruninstall
Name: "{localappdata}\King Automation AI\Super Post King\logs"; Flags: uninsneveruninstall

[Registry]
Root: HKCU; Subkey: "Software\King Automation AI\Super Post King"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"; Flags: uninsdeletevalue uninsdeletekeyifempty

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Mở thư mục dữ liệu"; Filename: "{localappdata}\King Automation AI\Super Post King"
Name: "{group}\Website King Automation AI"; Filename: "{#MyAppURL}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Đang cài Microsoft WebView2..."; Flags: waituntilterminated; Check: not WebView2Installed
Filename: "{tmp}\ChromeSetup.exe"; Parameters: "/silent /install"; StatusMsg: "Đang cài Google Chrome..."; Flags: waituntilterminated; Check: not ChromeInstalled
Filename: "{app}\{#MyAppExeName}"; Description: "Mở {#MyAppName}"; Flags: nowait postinstall

[Code]
function WebView2Installed: Boolean;
var
  Version: String;
begin
  Result :=
    (RegQueryStringValue(HKLM64, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
end;

function ChromeInstalled: Boolean;
begin
  Result :=
    FileExists(ExpandConstant('{pf64}\Google\Chrome\Application\chrome.exe')) or
    FileExists(ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe'));
end;
