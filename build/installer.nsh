; ============================================================
;  自定义安装向导
;   1. 加一页「要不要在桌面创建快捷方式」
;   2. 用坤坤图标重建快捷方式
;
;  为什么需要第 2 点：快捷方式的图标取自目标 exe，而被安装的 iKunReminder.exe
;  本身没有图标资源 —— electron-builder 要靠 rcedit 才能写进去，但 rcedit 由
;  app-builder 执行、需要解压 winCodeSign，那个包含有 macOS 符号链接，
;  普通 Windows 账户解压会失败。所以改成把 build/icon.ico 用 extraResources
;  一起装到 resources\icon.ico，安装时让快捷方式直接指向它。
;
;  接入 electron-builder 的三个钩子：customInit / customPageAfterChangeDir / customInstall
;
;  两个注意点：
;   1. 本文件在 MUI2 之前被 include，所以用到 MUI_HEADER_TEXT 的函数
;      必须写在 customPageAfterChangeDir 宏里（那个宏在 MUI2 之后才展开）。
;   2. 打包卸载程序时也会 include 本文件，但那段代码用不到这些变量，
;      会触发 warning 6001（被当作错误），所以整段用 BUILD_UNINSTALLER 挡掉。
; ============================================================
!ifndef BUILD_UNINSTALLER

  !include "nsDialogs.nsh"
  !include "LogicLib.nsh"

  Var DesktopLinkCheckbox
  Var DesktopLinkWanted
  Var KkExePath

  ; 静默安装（/S）不会走下面那一页，这里给个默认值：要桌面图标
  !macro customInit
    StrCpy $DesktopLinkWanted ${BST_CHECKED}
  !macroend

  ; 插在「选择安装目录」之后、「开始安装」之前
  !macro customPageAfterChangeDir
    Function DesktopLinkPageCreate
      !insertmacro MUI_HEADER_TEXT "快捷方式" "要不要在桌面放一个坤坤图标？"

      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${NSD_CreateLabel} 0 0 100% 26u "开始菜单里的快捷方式一定会创建。$\r$\n桌面上的这一个由你决定，以后随时可以删："
      Pop $0

      ${NSD_CreateCheckbox} 0 34u 100% 12u "在桌面创建快捷方式"
      Pop $DesktopLinkCheckbox
      ${NSD_SetState} $DesktopLinkCheckbox ${BST_CHECKED}
      ${NSD_SetFocus} $DesktopLinkCheckbox   ; 默认聚焦，空格键就能切换

      nsDialogs::Show
    FunctionEnd

    Function DesktopLinkPageLeave
      ${NSD_GetState} $DesktopLinkCheckbox $DesktopLinkWanted
    FunctionEnd

    Page custom DesktopLinkPageCreate DesktopLinkPageLeave
  !macroend

  ; electron-builder 建完快捷方式之后才调用 customInstall，
  ; 所以这里既能给快捷方式换图标，也能按勾选状态把桌面那个删掉
  !macro customInstall
    StrCpy $KkExePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

    ${If} ${FileExists} "$INSTDIR\resources\icon.ico"
      CreateShortCut "$newStartMenuLink" "$KkExePath" "" "$INSTDIR\resources\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"

      ${If} $DesktopLinkWanted == ${BST_CHECKED}
        CreateShortCut "$newDesktopLink" "$KkExePath" "" "$INSTDIR\resources\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      ${EndIf}
    ${EndIf}

    ${If} $DesktopLinkWanted != ${BST_CHECKED}
      Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
      WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
    ${EndIf}
  !macroend

!endif
