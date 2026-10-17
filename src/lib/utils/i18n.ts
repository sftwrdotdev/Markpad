import { createSubscriber } from 'svelte/reactivity';

export type LanguageCode =
	| 'en' // English
	| 'ja' // Japanese
	| 'zh-CN' // Chinese (Simplified)
	| 'zh-TW' // Chinese (Traditional)
	| 'ko' // Korean
	| 'ru' // Russian
	| 'es' // Spanish
	| 'fr' // French
	| 'de' // German
	| 'pt-BR' // Portuguese (Brazil)
	| 'it' // Italian
	| 'pl' // Polish
	| 'nl' // Dutch
	| 'sv' // Swedish
	| 'vi' // Vietnamese
	| 'pt' // Portuguese (European)
	| 'ro' // Romanian
	| 'hu' // Hungarian
	| 'cs' // Czech
	| 'sk' // Slovak
	| 'el' // Greek
	| 'fi' // Finnish
	| 'da' // Danish
	| 'no' // Norwegian
	| 'id' // Indonesian
	| 'tr'; // Turkish

export interface Translation {
    [key: string]: string | Translation;
}

export function getSupportedLanguages() {
	return [
		{ code: 'cs' as LanguageCode, name: 'Czech', nativeName: 'Čeština' },
		{ code: 'da' as LanguageCode, name: 'Danish', nativeName: 'Dansk' },
		{ code: 'nl' as LanguageCode, name: 'Dutch', nativeName: 'Nederlands' },
		{ code: 'en' as LanguageCode, name: 'English', nativeName: 'English' },
		{ code: 'fi' as LanguageCode, name: 'Finnish', nativeName: 'Suomi' },
		{ code: 'fr' as LanguageCode, name: 'French', nativeName: 'Français' },
		{ code: 'de' as LanguageCode, name: 'German', nativeName: 'Deutsch' },
		{ code: 'el' as LanguageCode, name: 'Greek', nativeName: 'Ελληνικά' },
		{ code: 'hu' as LanguageCode, name: 'Hungarian', nativeName: 'Magyar' },
		{ code: 'id' as LanguageCode, name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
		{ code: 'it' as LanguageCode, name: 'Italian', nativeName: 'Italiano' },
		{ code: 'ja' as LanguageCode, name: 'Japanese', nativeName: '日本語' },
		{ code: 'ko' as LanguageCode, name: 'Korean', nativeName: '한국어' },
		{ code: 'no' as LanguageCode, name: 'Norwegian', nativeName: 'Norsk' },
		{ code: 'pl' as LanguageCode, name: 'Polish', nativeName: 'Polski' },
		{ code: 'pt' as LanguageCode, name: 'Portuguese', nativeName: 'Português' },
		{ code: 'pt-BR' as LanguageCode, name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)' },
		{ code: 'ro' as LanguageCode, name: 'Romanian', nativeName: 'Română' },
		{ code: 'ru' as LanguageCode, name: 'Russian', nativeName: 'Русский' },
		{ code: 'sk' as LanguageCode, name: 'Slovak', nativeName: 'Slovenčina' },
		{ code: 'es' as LanguageCode, name: 'Spanish', nativeName: 'Español' },
		{ code: 'sv' as LanguageCode, name: 'Swedish', nativeName: 'Svenska' },
		{ code: 'tr' as LanguageCode, name: 'Turkish', nativeName: 'Türkçe' },
		{ code: 'vi' as LanguageCode, name: 'Vietnamese', nativeName: 'Tiếng Việt' },
		{ code: 'zh-CN' as LanguageCode, name: 'Chinese (Simplified)', nativeName: '简体中文' },
		{ code: 'zh-TW' as LanguageCode, name: 'Chinese (Traditional)', nativeName: '繁體中文' }
	];
}

// Only English ships in the startup bundle; every other language is its own
// chunk under `src/lib/locales/`, fetched on first use. `+layout.ts` awaits the
// saved language before the first render, so a window never paints in English
// first. A language switched to later renders in English for the moment its
// chunk takes to arrive, and `t()` re-runs its callers when it lands.
const en: Translation = {
    settings: {
        title: 'Settings',
        editor: 'Editor',
        preview: 'Preview',
        appearance: 'Appearance',
        toolbars: 'Toolbars',
        files: 'Files',
        shortcuts: 'Shortcuts',
        editorSettings: 'Editor Settings',
        previewSettings: 'Preview Settings',
        appearanceSettings: 'Appearance Settings',
        toolbarsSettings: 'Toolbar Settings',
        fileSettings: 'File Settings',
        autoSave: 'Auto-save edits',
        persistOpenEditors: 'Keep unsaved changes on close',
        persistOpenEditorsHint: 'Closing a window keeps unsaved changes and untitled documents instead of asking to save. They come back the next time Markpad opens.',
        settingsFile: 'Settings file',
        importSettings: 'Import…',
        exportSettings: 'Export…',
        importSettingsFailed: 'Could not import settings.',
        exportSettingsFailed: 'Could not export settings.',
        resetEditorSettings: 'Reset editor settings',
        resetPreviewSettings: 'Reset preview settings',
        font: 'Font',
        fontSize: 'Font Size',
        previewMaxWidth: 'Max width',
        previewBodyFont: 'Body font',
        previewBodyFontSize: 'Body font size',
        previewCodeFont: 'Code font',
        previewCodeFontSize: 'Code font size',
        wrapColumn: 'Wrap Column',
        wordWrap: 'Word Wrap',
        lineNumbers: 'Line Numbers',
        minimap: 'Minimap',
        vimMode: 'Vim Mode',
        statusBar: 'Status Bar',
        wordCount: 'Word Count',
        lineHighlight: 'Highlight Current Line',
        occurrencesHighlight: 'Highlight Occurrences',
        showWhitespace: 'Show Whitespace',
        stickyScroll: 'Sticky Headings',
        tocFollows: 'Outline Follows',
        tocFollowsCursor: 'Cursor Line',
        tocFollowsScroll: 'Scroll Position',
        previewCursor: 'Click in Preview Places Cursor',
        previewOccurrences: 'Highlight Matches of Selection',
        previewAnnotations: 'Temporary Highlights (Right-Click Menu)',
        previewTableBreakout: 'Wide Tables Can Exceed Max Width',
        previewTableScroll: 'Scroll Wide Tables',
        previewTableBreakoutHint: 'Spreads into the side margins',
        previewTableScrollHint: 'On: scroll. Off: squeeze to fit',
        showTabs: 'Show Tab Bar',
        restoreStateOnReopen: 'Reopen Previous Tabs',
        closeWindowWithLastTab: 'Close Window with Last Tab',
        openFileMode: 'Open existing files in',
        newFileDefaultMode: 'New file opens in editor',
        showRecentFiles: 'Show Recent Files',
        showFolderForDuplicateNames: 'Show Folder for Duplicate Names',
        animateJumpScroll: 'Animate Scrolling on Jump',
        animateCursor: 'Animate Cursor Movement',
        typewriterMode: 'Typewriter Mode',
        focusMode: 'Focus Mode',
        zenModeHint: 'Hides the tab bar, status bar, line numbers, minimap and outline',
        focusModeHint: 'Dims the text outside the paragraph you are in',
        typewriterModeHint: 'Keeps the line you are on in the middle of the editor',
        linksOpenInNewTab: 'Always Open Links in a New Tab',
        showTableOfContents: 'Show Table of Contents',
        zenMode: 'Zen Mode',
        theme: 'Theme',
        importVSCodeTheme: 'Import VS Code Theme',
        import: 'Import',
        importing: 'Importing...',
        browseThemes: 'Browse themes',
        deleteSelectedTheme: 'Delete selected theme',
        vsCodeThemes: 'VS Code Themes',
        language: 'Language',
        highlightColor: 'Text Highlight Color',
        imageDirectory: 'Image Directory',
        imageDirectoryHint: 'Folder for pasted and dropped images, created next to the document. Use ${filename} for the document\'s own name: ${filename}.assets gives every document its own folder instead of one shared img/.',
        scaleMacOSScreenshots: 'Scale macOS Screenshots',
        reduceSizeBy50: 'Reduce size by 50%',
        showEditorToolbar: 'Show Editor Toolbar',
        editorToolbar: 'Editor toolbar',
        applicationToolbar: 'Application toolbar',
        toolbarPlacement: 'Toolbar placement',
        toolbarOnBar: 'Bar',
        toolbarInMenu: 'Menu',
        resetToolbar: 'Reset toolbar',
        toolbarToc: 'Show/Hide Table of Contents',
        toolbarTabs: 'Show/Hide Tab Bar',
        toolbarViewSwitcher: 'View Switcher',
        toolbarViewModes: 'Preview | Split | Edit',
        toolbarSplitOnly: 'Split view only',
        toolbarEditOrSplit: 'Edit or split view only',
        toolbarDiskFileOnly: 'Files on disk only',
        toolbarZoomedOnly: 'Only when zoomed',
        move: 'Move',
        moveUp: 'Move up',
        moveDown: 'Move down',
        default: 'Default',
        cancel: 'Cancel',
        save: 'Save',
        discard: 'Discard',
        themeDefaultLight: 'Default Light',
        themeDefaultDark: 'Default Dark',
        themeFollowSystem: 'Follow System',
        resizeWindow: 'Resize settings window'
    },
    colors: {
        default: 'Default',
        yellow: 'Yellow',
        orange: 'Orange',
        red: 'Red',
        pink: 'Pink',
        purple: 'Purple',
        blue: 'Blue',
        cyan: 'Cyan',
        green: 'Green'
    },
    keys: {
        group: 'Editing Keys',
        enter: 'List: continue · Empty item: end',
        tab: 'Table: next cell · List: indent',
        shiftTab: 'Table: previous cell · Else: outdent',
        modEnter: 'Table: row below · Else: line below',
        modShiftEnter: 'Table: row above · Else: line above'
    },
    menu: {
        file: 'File',
        edit: 'Edit',
        view: 'View',
        newFile: 'New File',
        openFile: 'Open File',
        save: 'Save',
        saveAs: 'Save As',
        reloadFromDisk: 'Reload from Disk',
        closeFile: 'Close File',
        moveToNewWindow: 'Move to New Window',
        moveToWindow: 'Move to',
        window: 'Window',
        mergeAllWindows: 'Merge All Windows Here',
        setWindowTag: 'Window Tag…',
        windowTagPlaceholder: 'Name this window',
        windowTagClear: 'Remove Tag',
        windowTagTaken: 'Another window already uses this name — pick a different one.',
        pinnedTagTaken: 'A pinned tag already uses this name — pick a different one.',
        pinWindowTag: 'Pin Tag',
        unpinWindowTag: 'Unpin Tag',
        closeWindowTag: 'Close Tag',
        cut: 'Cut',
        copy: 'Copy',
        paste: 'Paste',
        selectAll: 'Select All',
        temporaryHighlight: 'Temporary Highlight',
        temporaryHighlightAll: 'Temporary Highlight All Matches',
        removeTemporaryHighlight: 'Remove Temporary Highlight',
        removeTemporaryHighlightAll: 'Remove All Matching Temporary Highlights',
        toggleEditMode: 'Toggle Edit Mode',
        toggleLiveMode: 'Toggle Live Mode',
        toggleSplitView: 'Toggle Split View',
        zoomIn: 'Zoom In',
        zoomOut: 'Zoom Out',
        resetZoom: 'Reset Zoom',
        settings: 'Settings',
        checkForUpdates: 'Check for updates…',
        github: 'GitHub',
        home: 'Home',
        exportHtml: 'Export as HTML',
        exportPdf: 'Export as PDF',
        exit: 'Exit',
        zenMode: 'Zen Mode',
        tabs: '{{action}} Tab Bar',
        back: 'Back',
        forward: 'Forward',
        openLocation: 'Open Location',
        openFileLocation: 'Open File Location',
        openInNewTab: 'Open in New Tab',
        copyFullPath: 'Copy Full Path',
        splitView: 'Split View',
        syncScroll: 'Sync Scroll',
        swapPanes: 'Swap Panes',
        fullWidth: 'Full Width',
        autoReload: 'Auto-Reload',
        editor: 'Editor',
        changeTheme: 'Change Theme',
        hide: 'Hide',
        show: 'Show',
        undoCloseTab: 'Undo Close Tab',
        rename: 'Rename',
        closeOtherTabs: 'Close Other Tabs',
        closeTabsToRight: 'Close Tabs to Right',
        renameFile: 'Rename file:',
        bold: 'Bold',
        italic: 'Italic',
        underline: 'Underline',
        strikethrough: 'Strikethrough',
        insertTable: 'Insert Table',
        insertTableRow: 'Insert Row Below',
        deleteTableRow: 'Delete Row',
        insertTableColumn: 'Insert Column Right',
        deleteTableColumn: 'Delete Column',
        inlineCode: 'Inline Code',
        codeBlock: 'Code Block',
        quote: 'Quote',
        heading1: 'Heading 1',
        heading2: 'Heading 2',
        heading3: 'Heading 3',
        bulletList: 'Bullet List',
        numberedList: 'Numbered List',
        checklist: 'Checklist',
        link: 'Link',
        nextTab: 'Next Tab',
        previousTab: 'Previous Tab',
        commandPalette: 'Command Palette',
        changeAllOccurrences: 'Change All Occurrences',
        toggleShowTabs: 'Toggle Tab Bar',
        copyReference: 'Copy Reference',
        saveImageAs: 'Save Image As...',
        saveDiagramAsSvg: 'Save Diagram As SVG...',
        wordWrapOff: 'Off',
        wordWrapOn: 'Window',
        wordWrapColumn: 'Column',
        find: 'Find…'
    },
    find: {
        placeholder: 'Find',
        next: 'Next match',
        previous: 'Previous match',
        close: 'Close',
        matchCount: '{{current}} of {{total}}',
        noMatches: 'No results',
        caseSensitive: 'Match case',
        wholeWord: 'Match whole word'
    },
    toast: {
        recoveryFailed: 'Could not keep unsaved changes.',
        imageSavedSuccessfully: 'Image saved successfully',
        failedToSaveImage: 'Failed to save image',
        diagramSavedAsSVG: 'Diagram saved as SVG',
        failedToSaveDiagram: 'Failed to save diagram',
        exportedHtmlMissingImages: 'Exported HTML, but {{count}} local image(s) could not be embedded.',
        exportPdfFailed: 'Failed to export PDF',
        reloadedFromDisk: 'Reloaded from disk',
        remoteImageNotSupported: 'Saving a remote image is not supported yet',
        openFailed: 'Failed to open {{target}}',
        launchableLinkRevealed: '{{target}} could run a program, so it was shown in its folder instead of opened',
        unsupportedFile: 'Unsupported file type: {{filename}}',
        autoSaveFailed: 'Auto-save failed — unsaved changes still in memory',
        noOtherWindows: 'No other windows to merge',
        savedNewerEdits: 'Saved — staying in edit mode because you have newer edits',
        openExportedFileFailed: 'Could not open exported file',
        partialDocument: 'Cannot edit yet — this file is not fully loaded',
        lossySaveBlocked: 'Not saved: parts of this file could not be read in any encoding and became "�" when it was opened. Saving would destroy the original — use "Save As" to write a copy',
        partialSaveBlocked: 'Not saved: only part of this file has loaded, and saving would truncate it — use "Save As" to write a copy',
        partialCopySaved: 'Copy saved, but it holds only the part of the document that had loaded',
        encodingUnmappable: 'Not saved: {{encoding}} cannot represent every character this document now contains (an emoji, most likely). Use "Save As" to write a copy as UTF-8',
        restoreInterrupted: 'Markpad did not finish restoring your session last time',
        restoreInterruptedDeferred: 'Markpad did not finish opening {path} last time, so it was skipped. Open it yourself to try again'
    },
    externalChange: {
        message: 'This file changed on disk while you had unsaved changes.',
        reload: 'Reload from disk',
        keepMine: 'Keep my version',
        compare: 'Compare',
        onDisk: 'On disk',
        mine: 'Your version',
        close: 'Close'
    },
    modal: {
        unsavedChanges: 'Unsaved Changes',
        youHaveUnsavedChanges: 'You have unsaved changes in "{title}". Do you want to save them before closing?',
        openExportedFileTitle: 'Open exported file?',
        openExportedHtmlMessage: 'HTML export was saved. Open it now?'
    },
    update: {
        checkingHeader: 'Checking for updates…',
        checkingBody: 'Looking for the latest version of Markpad…',
        upToDateHeader: 'You\'re up to date',
        upToDateBody: 'You\'re using the latest version of Markpad (v{{version}}).',
        upToDateBodyNoVersion: 'You\'re using the latest version of Markpad.',
        availableHeader: 'Update available',
        availableBody: 'Markpad v{{latest}} is available. You\'re on v{{current}}.',
        releaseNotes: 'Release notes',
        packageManagedHeader: 'Updates come from your package manager',
        packageManagedBody: 'This copy of Markpad was installed by a package manager, so it cannot replace itself. Get the newest version the same way you installed this one, or download a package from the releases page.',
        downloadingHeader: 'Downloading update…',
        downloadingBody: 'Downloading Markpad v{{version}}…',
        downloadingProgress: '{{downloaded}} MB of {{total}} MB ({{pct}}%)',
        downloadingProgressUnknown: '{{downloaded}} MB downloaded',
        downloadingHint: 'Markpad will restart automatically when the update is ready.',
        errorCheckHeader: 'Update check failed',
        errorCheckBody: 'Could not check for updates.',
        errorDownloadHeader: 'Update download failed',
        errorDownloadBody: 'Could not download or install the update.',
        errorInstallHeader: 'Restart failed',
        errorInstallBody: 'The update was downloaded but Markpad could not restart automatically. Please quit and reopen Markpad to finish installing.',
        cancel: 'Cancel',
        ok: 'OK',
        downloadInstall: 'Download & Install',
        closeOtherWindows: 'Close these windows first, or move their tabs here with Merge All Windows Here. After the update, Markpad reopens the tabs in this window.',
        close: 'Close',
        retry: 'Retry'
    },
    home: {
        welcomeToMarkpad: 'Welcome to Markpad',
        recentFiles: 'Recent Files',
        pinnedTags: 'Pinned Windows',
        pinnedFileCount: '{{count}} files',
        noRecentFiles: 'No recent files',
        removeFromHistory: 'Remove from history',
        newFile: 'New File',
        openFile: 'Open File',
    },
    editor: {
        status: {
            lineCol: 'Ln {{line}}, Col {{col}}',
            selected: '{{count}} selected',
            selections: '{{count}} selections',
            words: '{{count}} words'
        }
    },
    frontMatter: {
        properties: 'Properties',
        addTag: 'Add tag',
        tagList: '{{field}} tags',
        editTag: 'Edit {{field}} tag {{tag}}',
        removeTag: 'Remove {{tag}} from {{field}}',
        addTagTo: 'Add {{field}} tag'
    },
    tooltip: {
        menu: 'Menu',
        more: 'More',
        back: 'Back',
        forward: 'Forward',
        moreActions: 'More Actions',
        settings: 'Settings',
        resetZoom: 'Reset Zoom',
        reset: 'Reset',
        zenMode: 'Zen mode',
        toggleZenMode: 'Toggle Zen Mode',
        tabs: '{{action}} tab bar',
        hide: 'Hide',
        show: 'Show',
        openFileLocation: 'Open file location',
        toggleScrollSync: 'Toggle Scroll Sync',
        scrollSync: 'Scroll sync',
        swapPanes: 'Swap editor and preview',
        toggleFullWidth: 'Toggle Full Width',
        fullWidth: 'Toggle full width',
        reloadFromDisk: 'Reload from Disk',
        toggleAutoReload: 'Toggle Auto-Reload',
        autoReload: 'Auto-Reload',
        editorToolbar: 'Editor Toolbar',
        changeTheme: 'Change Theme',
        undock: 'Undock',
        dock: 'Dock',
        switchSide: 'Switch side',
        toggleFold: 'Toggle fold',
        undockToc: 'Undock Table of Contents',
        dockToc: 'Dock Table of Contents',
        showTableOfContents: 'Show Table of Contents',
        hideTableOfContents: 'Hide Table of Contents',
        newTab: 'New Tab',
        close: 'Close',
        find: 'Find'
    },
    toc: {
        noHeadingsFound: 'No headings found',
        resizeTableOfContents: 'Resize table of contents'
    },
    dragAndDrop: {
        embed: 'Drop to Embed',
        open: 'Drop to Open'
    },
    theme: {
        followSystem: 'Follow System',
        defaultLight: 'Default Light',
        defaultDark: 'Default Dark'
    },
    tabs: {
        untitled: 'Untitled',
        home: 'Home'
    },
    common: {
        close: 'Close',
        minimize: 'Minimize',
        maximize: 'Maximize',
        loadingFullDocument: 'Loading full document...',
        decrease: 'Decrease',
        increase: 'Increase'
    }
};

const dictionaries = new Map<LanguageCode, Translation>([['en', en]]);
let localeLoaded = () => {};
const dependOnLocaleLoads = createSubscriber((update) => {
    localeLoaded = update;
    return () => {
        localeLoaded = () => {};
    };
});

export async function loadLocale(lang: LanguageCode): Promise<Translation> {
    let dictionary = dictionaries.get(lang);
    if (!dictionary) {
        dictionary = (await import(`../locales/${lang}.ts`)).default as Translation;
        dictionaries.set(lang, dictionary);
        localeLoaded();
    }
    return dictionary;
}

// `lang` is deliberately required. When it defaulted to 'en', a call site that
// forgot to pass the language compiled, ran, and showed English in all 26
// languages — silently, including on aria-labels a screen reader reads out.
// The default is the bug; the compiler is the check. Do not restore it.
export function t(key: string, lang: LanguageCode): string {
    const keys = key.split('.');
    
    const getValue = (dict: any) => {
        let res = dict;
        for (const k of keys) {
            if (res && typeof res === 'object' && k in res) res = res[k];
            else return undefined;
        }
        return typeof res === 'string' ? res : undefined;
    };

    const dictionary = dictionaries.get(lang);
    if (!dictionary) {
        dependOnLocaleLoads();
        void loadLocale(lang);
    }

    let result = getValue(dictionary);
    if (result !== undefined) return result;
    
    if (lang !== 'en') {
        result = getValue(en);
        if (result !== undefined) return result;
    }
    
    return key;
}
