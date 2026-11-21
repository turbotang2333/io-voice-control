import hashlib
import json
import sys
import zipfile


def verify(payload):
    needles = [value.encode('utf-8') for value in payload['needles']]
    keep = max(map(len, needles), default=1) - 1

    def scan(archive, info):
        digest = hashlib.sha256()
        tail = b''
        found = False
        with archive.open(info) as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
                sample = tail + chunk
                found = found or any(value in sample for value in needles)
                tail = sample[-keep:] if keep else b''
        return digest.hexdigest(), found

    with zipfile.ZipFile(payload['zip']) as archive:
        files = {}
        for info in archive.infolist():
            if info.is_dir():
                continue
            name = info.filename.removeprefix('./')
            if (name.startswith('/') or '\\' in name or ':' in name
                    or any(part in ('', '.', '..') for part in name.split('/'))
                    or name.lower() in files):
                raise ValueError('UNSAFE_ARCHIVE_ENTRY')
            files[name.lower()] = info
        manifest = json.loads(archive.read(files['manifest.json']))
        expected = {entry['path'].lower(): entry for entry in manifest['files']}
        if set(files) != set(expected) | {'manifest.json'}:
            raise ValueError('ARCHIVE_FILE_SET_MISMATCH')
        for name, entry in expected.items():
            info = files[name]
            if info.file_size != entry['bytes']:
                raise ValueError('ARCHIVE_SIZE_MISMATCH')
            digest, found = scan(archive, info)
            if digest != entry['sha256']:
                raise ValueError('ARCHIVE_HASH_MISMATCH')
            if found:
                raise ValueError('DEVELOPER_CONFIGURATION_MATCH')

    with zipfile.ZipFile(payload['apk']) as archive:
        for info in archive.infolist():
            if not info.is_dir() and scan(archive, info)[1]:
                raise ValueError('DEVELOPER_PHONE_CONFIGURATION_MATCH')
    return {'archiveVerified': True, 'connectorFilesVerified': len(expected),
            'connectorPrivateConfigurationMatches': 0, 'phonePrivateConfigurationMatches': 0}


if __name__ == '__main__':
    print(json.dumps(verify(json.load(sys.stdin))))
