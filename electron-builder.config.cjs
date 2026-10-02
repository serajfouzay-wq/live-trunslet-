// Builds the Windows installer. On Linux/macOS (no Wine) the exe icon is patched by scripts/after-pack.cjs.
const notWindows = process.platform !== 'win32';

module.exports = {
  appId: 'com.livetranslate.app',
  productName: 'Live Translate',
  copyright: 'Live Translate',
  asar: false, // plain files: the built-in server serves public/ and views/ straight from disk
  directories: { output: 'dist', buildResources: 'build' },
  files: ['electron/**', 'server/**', 'public/**', 'views/**', 'build/icon.png', 'package.json', '!**/*.map', '!**/*.md'],
  win: {
    // Windows machines build the installer; Linux (no Wine) builds the portable exe and a zip.
    target: notWindows ? [{ target: 'portable', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }] : [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }],
    icon: 'build/icon.ico',
    signAndEditExecutable: !notWindows,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Live Translate',
    artifactName: 'LiveTranslate-Setup-${version}.exe',
    deleteAppDataOnUninstall: false,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
  },
  portable: { artifactName: 'LiveTranslate-Portable-${version}.exe' },
  afterPack: notWindows ? 'scripts/after-pack.cjs' : undefined,
};
