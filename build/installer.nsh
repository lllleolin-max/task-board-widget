; Keep the value name and command identical to Electron's login item settings.
; Tests override these keys with an isolated, non-startup registry subtree.
!define /IfNDef TASKBOARD_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define /IfNDef TASKBOARD_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"

!macro taskboardRemoveStartup
  DeleteRegValue HKCU "${TASKBOARD_RUN_KEY}" "${APP_ID}"
  DeleteRegValue HKCU "${TASKBOARD_APPROVED_KEY}" "${APP_ID}"
!macroend

; $0 is the checkbox state. Use the same quoted command as Electron on Windows.
!macro taskboardSetStartup
  ${If} $0 == ${BST_CHECKED}
    WriteRegStr HKCU "${TASKBOARD_RUN_KEY}" "${APP_ID}" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    DeleteRegValue HKCU "${TASKBOARD_APPROVED_KEY}" "${APP_ID}"
  ${Else}
    !insertmacro taskboardRemoveStartup
  ${EndIf}
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    LangString taskboardLaunch 1033 "Launch Taskboard after installation"
    LangString taskboardLaunch 2052 "安装后启动 Taskboard"
    LangString taskboardLaunch 1028 "安裝後啟動 Taskboard"
    LangString taskboardLaunch 1041 "インストール後に Taskboard を起動"
    LangString taskboardLaunch 1042 "설치 후 Taskboard 실행"
    LangString taskboardStartup 1033 "Start Taskboard automatically when I sign in"
    LangString taskboardStartup 2052 "开机自动启动 Taskboard（当前用户）"
    LangString taskboardStartup 1028 "開機自動啟動 Taskboard（目前使用者）"
    LangString taskboardStartup 1041 "ログイン時に Taskboard を自動起動"
    LangString taskboardStartup 1042 "로그인 시 Taskboard 자동 시작"
  !endif
!macroend

!macro customFinishPage
  ; Reuse the two native MUI checkboxes; both are checked by default.
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "$(taskboardLaunch)"
  !define MUI_FINISHPAGE_RUN_FUNCTION taskboardLaunch
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "$(taskboardStartup)"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION taskboardStartupHandled
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE taskboardFinish
  !insertmacro MUI_PAGE_FINISH

  Function taskboardFinish
    ; MUI calls LEAVE before RUN, so the app sees the chosen setting at launch.
    ${NSD_GetState} $mui.FinishPage.ShowReadme $0
    !insertmacro UAC_AsUser_Call Function taskboardApplyStartup ${UAC_SYNCREGISTERS}|${UAC_SYNCINSTDIR}
  FunctionEnd

  Function taskboardApplyStartup
    !insertmacro taskboardSetStartup
  FunctionEnd

  Function taskboardLaunch
    ; Match electron-builder's assisted installer launch, without redeclaring
    ; the global variable used by its separate silent-install StartApp macro.
    ${If} ${isUpdated}
      StrCpy $1 "--updated"
    ${Else}
      StrCpy $1 ""
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function taskboardStartupHandled
    ; Both checked and unchecked states were already applied in taskboardFinish.
  FunctionEnd
!macroend

!macro customUnInstall
  ; The old uninstaller also runs during upgrades: preserve the user's setting.
  ${IfNot} ${isUpdated}
    !insertmacro UAC_AsUser_Call Function un.taskboardRemoveStartup ${UAC_SYNCREGISTERS}
  ${EndIf}
!macroend

!ifdef BUILD_UNINSTALLER
  Function un.taskboardRemoveStartup
    !insertmacro taskboardRemoveStartup
  FunctionEnd
!endif
