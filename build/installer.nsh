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

  ; ---------------------------------------------------------------
  ;  用户自定义皮肤（安装目录\skins）的搬运
  ;  更新时安装程序会先把整个安装目录递归删掉（electron-builder 的
  ;  uninstaller.nsh 里那句 RMDir /r $INSTDIR），用户放在 skins/ 里的
  ;  皮肤会跟着一起没 —— 朋友反馈的「更新后自定义皮肤没了」就是这个。
  ;    customInit    在卸载旧版本【之前】跑 → 把 skins 整个备份到 %TEMP%
  ;    customInstall 在新文件装完【之后】跑 → 建回目录 + 把备份放回去
  ;  ⚠️ CopyFiles 不递归子目录，所以按皮肤「一层目录」的约定遍历：
  ;     skins/<皮肤名>/skin.json + 精灵图。
  ;  ⚠️ 宏名（customInit / customInstall）不能改，electron-builder 用
  ;     !ifmacrodef 判断，名字不对就静默不调用。
  ; ---------------------------------------------------------------
  !macro kkSkinsBackup
    DetailPrint "保留用户自定义皮肤（skins）..."
    RMDir /r "$TEMP\iKunReminder-skins-keep"
    ${If} ${FileExists} "$INSTDIR\skins\*.*"
      CreateDirectory "$TEMP\iKunReminder-skins-keep"
      FindFirst $0 $1 "$INSTDIR\skins\*.*"
      kkBkLoop:
        StrCmp $1 "" kkBkDone
        StrCmp $1 "." kkBkNext
        StrCmp $1 ".." kkBkNext
        ${If} ${FileExists} "$INSTDIR\skins\$1\*.*"
          CreateDirectory "$TEMP\iKunReminder-skins-keep\$1"
          CopyFiles /SILENT "$INSTDIR\skins\$1\*.*" "$TEMP\iKunReminder-skins-keep\$1"
        ${Else}
          CopyFiles /SILENT "$INSTDIR\skins\$1" "$TEMP\iKunReminder-skins-keep"
        ${EndIf}
      kkBkNext:
        FindNext $0 $1
        Goto kkBkLoop
      kkBkDone:
      FindClose $0
    ${EndIf}
  !macroend

  ; 静默安装（/S）不会走下面那一页，这里给个默认值：要桌面图标
  !macro customInit
    StrCpy $DesktopLinkWanted ${BST_CHECKED}
    ; 上一次安装半途挂了、备份还没放回去时，别覆盖它
    ${IfNot} ${FileExists} "$TEMP\iKunReminder-skins-keep\*.*"
      !insertmacro kkSkinsBackup
    ${EndIf}
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

    ; 用户皮肤目录：全新安装时建一个空的；更新时把刚才备份的放回去
    CreateDirectory "$INSTDIR\skins"
    ${If} ${FileExists} "$TEMP\iKunReminder-skins-keep\*.*"
      DetailPrint "恢复用户自定义皮肤（skins）..."
      FindFirst $0 $1 "$TEMP\iKunReminder-skins-keep\*.*"
      kkRsLoop:
        StrCmp $1 "" kkRsDone
        StrCmp $1 "." kkRsNext
        StrCmp $1 ".." kkRsNext
        ${If} ${FileExists} "$TEMP\iKunReminder-skins-keep\$1\*.*"
          CreateDirectory "$INSTDIR\skins\$1"
          CopyFiles /SILENT "$TEMP\iKunReminder-skins-keep\$1\*.*" "$INSTDIR\skins\$1"
        ${Else}
          CopyFiles /SILENT "$TEMP\iKunReminder-skins-keep\$1" "$INSTDIR\skins"
        ${EndIf}
      kkRsNext:
        FindNext $0 $1
        Goto kkRsLoop
      kkRsDone:
      FindClose $0
      RMDir /r "$TEMP\iKunReminder-skins-keep"
    ${EndIf}
    ; skins 里的说明文档（README-skins.txt）由程序首启时自己补，改文案不用重打安装包

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
