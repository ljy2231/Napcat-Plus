"""Keep external runtime dependencies and the first-boot seed ZIP in sync."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path('/app/napcat')
archive = Path('/app/NapCat.Shell.zip')
with ZipFile(archive) as original:
    for entry in original.infolist():
        if not entry.filename.startswith('node_modules/'):
            continue
        destination = (root / entry.filename).resolve()
        if not destination.is_relative_to(root.resolve()):
            raise SystemExit('Unsafe runtime dependency path')
        original.extract(entry, root)
# The archive is intentionally reconstructed only at image-build time.
# Runtime config/QQ sessions/plugins are bind mounts and are never baked in.
with ZipFile(archive, 'w', ZIP_DEFLATED) as output:
    for file in sorted(root.rglob('*')):
        if file.is_file():
            output.write(file, file.relative_to(root).as_posix())
print('Prepared QQ Bot Console runtime and first-start archive')
