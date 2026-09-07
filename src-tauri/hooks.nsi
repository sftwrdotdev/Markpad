; NSIS installer hooks, included by the bundler template
; (crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi) and inserted from
; `!ifmacrodef NSIS_HOOK_POSTINSTALL` / `!ifmacrodef NSIS_HOOK_POSTUNINSTALL`.
; There is no underscore between POST and INSTALL, and `!ifmacrodef` is a
; compile-time conditional, so any other spelling is skipped in silence.
;
; Everything a hook does here has to be something the template does not already
; do. The template creates the desktop shortcut from the finish-page checkbox
; (and automatically for silent and passive installs), registers `.md` and
; `.markdown` from `bundle.fileAssociations` via APP_ASSOCIATE, and writes every
; key through SHCTX so it follows `installMode`. Duplicating any of that from
; here overrides a choice the user was already given.

; Drop the uninstall entry a pre-2.7 custom install left in one hive.
;
; Those installs wrote `UninstallString = "…\Markpad.exe" --uninstall` under the
; same key this installer uses. Section Install overwrites that value, but only
; in SHCTX -- so when the old install chose the other hive, its entry survives as
; a second Add/Remove Programs row pointing at a command the binary no longer
; answers. Only the custom installer ever wrote `--uninstall`, so matching on the
; tail of the value cannot hit an entry this installer owns.
;
; DeleteRegKey under HKLM fails without elevation. That is left as a silent
; no-op: the binary forwards a stray `--uninstall` to uninstall.exe on its own,
; which is the same outcome by a slower road.
!macro MARKPAD_DROP_LEGACY_UNINSTALL_ENTRY HIVE
  Push $0
  Push $1
  ClearErrors
  ReadRegStr $0 ${HIVE} "${UNINSTKEY}" "UninstallString"
  ${IfNot} ${Errors}
    StrCpy $1 $0 "" -11
    ${If} $1 == "--uninstall"
      DeleteRegKey ${HIVE} "${UNINSTKEY}"
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend

; The ProgID the bundler template registers `.md` and `.markdown` under. It is
; `bundle.fileAssociations[].name` from tauri.conf.json verbatim -- the template
; expands `{{or association.name ext}}` into the APP_ASSOCIATE FILECLASS
; argument -- and nothing in the build exports it as a define, so it is repeated
; here. scripts/nsisInstallerHooks.test.ts fails if the two ever disagree.
!define MARKPAD_PROGID "Markdown File"

; Make Markpad selectable from Explorer's "Open with" list (#756).
;
; APP_ASSOCIATE writes one thing: `.md`'s default value, meaning "Markpad is the
; handler for .md". Since Windows 8 that value is not the handler -- an existing
; `.md\UserChoice`, written by the shell when the user or another installer last
; picked something, wins over it, and no installer may write UserChoice itself.
; So on a machine that already had a Markdown handler the association silently
; loses, which is the whole of what the reporter sees.
;
; The way back is the Open With dialog, and that dialog does not enumerate
; default-value handlers. It reads `OpenWithProgids` on the extension and
; `Software\Classes\Applications\<exe>` entries carrying a matching
; SupportedTypes. The template writes neither, so Markpad appears in that list
; only while it already is the default -- exactly when it is not needed. These
; four keys are what put it there in the case that matters.
;
; SupportedTypes is what filters the Applications entry into the list for a
; given extension; FriendlyAppName is the label, without which the row reads
; "Markpad.exe".
!macro MARKPAD_REGISTER_OPEN_WITH
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".md" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".markdown" ""
  WriteRegStr SHCTX "Software\Classes\.md\OpenWithProgids" "${MARKPAD_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\.markdown\OpenWithProgids" "${MARKPAD_PROGID}" ""
!macroend

; And hand them back. The Applications key is addressed by executable *name*,
; not path, so a portable copy the user pointed Explorer at by hand owns the
; same key -- deleting it outright would take that association down with this
; install. Matching the command against $INSTDIR first is what the template
; already does for deep links, and it is the same rule #255 asked for.
;
; The OpenWithProgids values name ${MARKPAD_PROGID}, a ProgID APP_UNASSOCIATE
; has just deleted, so they point at nothing by the time this runs either way.
!macro MARKPAD_UNREGISTER_OPEN_WITH
  Push $0
  ReadRegStr $0 SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" ""
  ${If} $0 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
    DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  ${EndIf}
  Pop $0
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "${MARKPAD_PROGID}"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "${MARKPAD_PROGID}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro MARKPAD_REGISTER_OPEN_WITH

  ; The template registers the file associations through FileAssociation.nsh but
  ; never inserts that header's own UPDATEFILEASSOC, so Explorer can go on
  ; serving the previous handler and icon for `.md` until the next logon.
  ; Broadcasting SHCNE_ASSOCCHANGED (0x08000000) with SHCNF_IDLIST (0) and two
  ; null items is the documented way to tell it to re-read them. It covers the
  ; keys above too.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ; Section Install has already written the good value into SHCTX by the time
  ; this hook runs, so neither pass can match the entry that was just written.
  !insertmacro MARKPAD_DROP_LEGACY_UNINSTALL_ENTRY HKCU
  !insertmacro MARKPAD_DROP_LEGACY_UNINSTALL_ENTRY HKLM
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro MARKPAD_UNREGISTER_OPEN_WITH

  ; And again once APP_UNASSOCIATE has handed `.md` back.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
