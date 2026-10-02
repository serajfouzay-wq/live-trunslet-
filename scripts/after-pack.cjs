// Without Wine, electron-builder cannot stamp our icon/name into the .exe. Do it here with a pure-JS PE editor.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  try {
    const ResEdit = await import('resedit');
    const pe = ResEdit.NtExecutable.from(fs.readFileSync(exe));
    const res = ResEdit.NtExecutableResource.from(pe);

    const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(context.packager.projectDir, 'build', 'icon.ico')));
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
    const target = groups[0] || { id: 101, lang: 1033 };
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, target.id, target.lang, ico.icons.map((i) => i.data));

    const infos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
    if (infos[0]) {
      const v = context.packager.appInfo.version;
      infos[0].setStringValues({ lang: 1033, codepage: 1200 }, {
        FileDescription: 'Live Translate', ProductName: 'Live Translate', CompanyName: 'Live Translate',
        OriginalFilename: 'Live Translate.exe', InternalName: 'Live Translate', FileVersion: v, ProductVersion: v,
        LegalCopyright: 'Live Translate',
      });
      infos[0].outputToResourceEntries(res.entries);
    }
    res.outputResource(pe);
    fs.writeFileSync(exe, Buffer.from(pe.generate()));
    console.log('  • exe icon and details patched');
  } catch (e) {
    console.warn(`  • could not patch the exe icon (${e.message}); the app still works, it just shows the default icon`);
  }
};
