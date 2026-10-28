; Runs when Vexlo is uninstalled: removes what the app registered outside its own folder.
; (App data in %APPDATA%\Vexlo is removed by deleteAppDataOnUninstall; downloaded files are never touched.)
!macro customUnInstall
  ; browser pairing entries
  DeleteRegKey HKCU "Software\Mozilla\NativeMessagingHosts\dev.vexlo.host"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\dev.vexlo.host"
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\dev.vexlo.host"
  ; "start with Windows" entry (value name depends on the app name: try the likely ones)
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Vexlo"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "vexlo"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "dev.vexlo.app"
!macroend
