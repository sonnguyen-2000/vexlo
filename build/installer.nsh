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
