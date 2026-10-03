; cubehold installer for Windows (Inno Setup). Built by packaging/build.ts:
;   ISCC /DAppVersion=... /DSourceDir=build\win-x64\cubehold /DOutputDir=build /DIconFile=... cubehold.iss
;
; Per-user install without admin rights, into %LOCALAPPDATA%\Programs\cubehold.
; Each version goes into its own app-VERSION folder next to cubehold.exe, so an
; update never touches files an agent that still hosts servers runs from; the
; tray app removes old folders once they are free. Data stays in
; %LOCALAPPDATA%\cubehold and survives updates and (unless the owner says so)
; uninstalls.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{0E4F58BA-A27D-4F94-BB93-AA44A91D7ADF}
AppName=cubehold
AppVersion={#AppVersion}
AppVerName=cubehold {#AppVersion}
AppPublisher=cubehold
AppComments=Self-hosted Minecraft server manager
DefaultDirName={localappdata}\Programs\cubehold
DisableDirPage=yes
DefaultGroupName=cubehold
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename=cubehold-setup-{#AppVersion}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\cubehold.exe
UninstallDisplayName=cubehold
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; The tray app is asked to quit in PrepareToInstall; this is the fallback.
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: autostart; Description: "Start cubehold when I sign in, so the panel is there for my servers"
Name: desktopicon; Description: "{cm:CreateDesktopIcon}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\cubehold"; Filename: "{app}\cubehold.exe"; Comment: "Minecraft server manager"
Name: "{autodesktop}\cubehold"; Filename: "{app}\cubehold.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "cubehold"; ValueData: """{app}\cubehold.exe"" --background"; Tasks: autostart; Flags: uninsdeletevalue

[Run]
Filename: "{app}\cubehold.exe"; Description: "Open cubehold"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Close the tray app, save the worlds, stop the servers and the agent.
Filename: "{app}\cubehold.exe"; Parameters: "--uninstall"; RunOnceId: "StopCubehold"; Flags: runhidden waituntilterminated

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  // An update: close the running tray app (and its panel). Servers keep running.
  if FileExists(ExpandConstant('{app}\cubehold.exe')) then
    Exec(ExpandConstant('{app}\cubehold.exe'), '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\cubehold');
    if DirExists(DataDir) then
      if SuppressibleMsgBox('Also delete your Minecraft servers, worlds, backups and settings?' + #13#10#13#10 +
         'They are in ' + DataDir + '.' + #13#10 +
         'Choose No to keep them for a later install.',
         mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
