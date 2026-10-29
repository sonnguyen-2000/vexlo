; Uninstall clean-up for Vexlo. Downloaded files and the folders that hold them are never touched.

; Runs first when the uninstaller starts: a Vexlo left running in the tray (or a browser-pairing helper that uses
; Vexlo.exe) keeps files locked, which is what used to leave the install folder behind.
!macro customUnInit
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Sleep 800
!macroend

!macro customUnInstall
  ; browser pairing entries
  DeleteRegKey HKCU "Software\Mozilla\NativeMessagingHosts\dev.vexlo.host"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\dev.vexlo.host"
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\dev.vexlo.host"
  ; "start with Windows" entry (value name depends on the app name: try the likely ones)
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Vexlo"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "vexlo"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "dev.vexlo.app"

  ; Only on a real uninstall (an update runs this too and must keep settings and the pairing code).
  ${ifNot} ${isUpdated}
    ; app data: settings, pairing code, native-host files, cache, update cache, and folders of the earlier app names
    RMDir /r "$APPDATA\Vexlo"
    RMDir /r "$APPDATA\vexlo"
    RMDir /r "$LOCALAPPDATA\Vexlo"
    RMDir /r "$LOCALAPPDATA\vexlo"
    RMDir /r "$LOCALAPPDATA\vexlo-updater"
    RMDir /r "$APPDATA\ZapGet"
    RMDir /r "$APPDATA\zapget"
    RMDir /r "$APPDATA\SwiftGet"
    RMDir /r "$APPDATA\swiftget"
    ; whatever is left of the install folder (files that were locked or created after install)
    SetOutPath "$TEMP"
    RMDir /r "$INSTDIR"
  ${endIf}
!macroend

; ---- Installer option: "Start Vexlo when Windows starts", a checkbox page right after the folder page.
; The answer (1 = yes, 0 = no) is left as a flag file; the app turns it into its "Start with Windows" setting on first run.
; The page is skipped on updates and silent installs.
!ifndef UNINSTALLER_OUT_FILE
  !include nsDialogs.nsh
  !include LogicLib.nsh

  Var VexloAutoBox
  Var VexloAutoState

  Function VexloOptionsPage
    ${if} ${isUpdated}
      Abort
    ${endIf}
    !insertmacro MUI_HEADER_TEXT "Startup" "Choose how Vexlo starts on this PC."
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateCheckbox} 0 8u 100% 12u "Start Vexlo when Windows starts"
    Pop $VexloAutoBox
    ${NSD_CreateLabel} 12u 24u 95% 24u "Vexlo runs quietly in the system tray so it can catch downloads from your browser. You can change this later in Settings."
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function VexloOptionsLeave
    ${NSD_GetState} $VexloAutoBox $VexloAutoState
  FunctionEnd

  !macro customPageAfterChangeDir
    Page custom VexloOptionsPage VexloOptionsLeave
  !macroend

  !macro customInstall
    ${ifNot} ${isUpdated}
    ${ifNot} ${Silent}
      CreateDirectory "$APPDATA\Vexlo"
      FileOpen $0 "$APPDATA\Vexlo\autostart.flag" w
      ${if} $VexloAutoState == ${BST_CHECKED}
        FileWrite $0 "1"
      ${else}
        FileWrite $0 "0"
      ${endIf}
      FileClose $0
    ${endIf}
    ${endIf}
  !macroend
!endif
