"""Preserve official members byte-for-byte except the fingerprint-selected DEX files."""
import copy
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

SIGNATURE = re.compile(r"META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))$", re.I)
DEX = re.compile(r"classes[0-9]*\.dex$")
def assemble_apk(original, assembled, addon_dex, certificate, output, replaced_dex, hook_dex="classes5.dex", addon_name="classes6.dex", wireless_only=False):
    replaced = set(replaced_dex)
    match = re.fullmatch(r"classes([1-9][0-9]*)\.dex", hook_dex)
    if not match or int(match.group(1)) < 2:
        raise ValueError("Invalid hook DEX")
    hook_number = int(match.group(1))
    original_dex = {"classes.dex", *(f"classes{i}.dex" for i in range(2, hook_number))}
    if addon_name != f"classes{hook_number + 1}.dex" or not replaced or not replaced < original_dex or "classes.dex" in replaced:
        raise ValueError("Unsupported DEX replacement layout")
    documents = {
        "assets/ZXING-LICENSE.txt": "android-addon/assets/ZXING-LICENSE.txt",
        "assets/RAYNEO-PASEO-LICENSE.txt": "LICENSE",
        "assets/RAYNEO-PASEO-THIRD-PARTY-NOTICES.md": "THIRD_PARTY_NOTICES.md",
    }
    root = Path(__file__).resolve().parent.parent
    document_bytes = {name: (root / path).read_bytes() for name, path in documents.items()}
    if any(not content for content in document_bytes.values()):
        raise ValueError("Empty license document")
    connection_asset = "assets/rayneo-paseo-wireless-only" if wireless_only else "assets/rayneo-paseo-local.cer"
    additions = {hook_dex, addon_name, connection_asset, *documents}
    with zipfile.ZipFile(original) as stock, zipfile.ZipFile(assembled) as build:
        for archive in (stock, build):
            if len(archive.namelist()) != len(set(archive.namelist())):
                raise ValueError("Duplicate input ZIP entries")
        if {name for name in stock.namelist() if DEX.fullmatch(name)} != original_dex:
            raise ValueError("Unexpected original DEX layout")
        if {name for name in build.namelist() if DEX.fullmatch(name)} != original_dex | {hook_dex}:
            raise ValueError("Unexpected rebuilt DEX layout")
        reserved = additions | {"assets/rayneo-paseo-local.cer", "assets/rayneo-paseo-wireless-only"}
        if reserved & set(stock.namelist()):
            raise ValueError("Extension entry already exists in the original")
        with zipfile.ZipFile(output, "w") as result:
            for info in stock.infolist():
                if SIGNATURE.fullmatch(info.filename) or info.filename in replaced:
                    continue
                result.writestr(copy.copy(info), stock.read(info.filename))
            for name in sorted(replaced | {hook_dex}):
                result.writestr(name, build.read(name), compress_type=zipfile.ZIP_DEFLATED)
            result.writestr(addon_name, addon_dex.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
            result.writestr(connection_asset, b"1" if wireless_only else certificate.read_bytes())
            for name, content in document_bytes.items():
                result.writestr(name, content)
        with zipfile.ZipFile(output) as result:
            if result.testzip() is not None:
                raise ValueError("Invalid output ZIP")
            expected_names = {name for name in stock.namelist() if not SIGNATURE.fullmatch(name)} | additions
            if set(result.namelist()) != expected_names:
                raise ValueError("Unexpected output members")
            for info in stock.infolist():
                if SIGNATURE.fullmatch(info.filename) or info.filename in replaced:
                    continue
                if result.read(info.filename) != stock.read(info.filename):
                    raise ValueError("Unexpected changed member: " + info.filename)
    return {"preserved_original_resources_and_libraries": True,
            "changed_or_added": sorted(replaced | additions), "custom_ota_injected": False, "installed": False}


def main():
    args = sys.argv[1:]
    wireless_only = "--wireless-only" in args
    if wireless_only:
        args.remove("--wireless-only")
    original, assembled, addon_dex, certificate, output = map(Path, args)
    profiles = json.loads(Path(__file__).with_name("host-profiles.json").read_text(encoding="utf-8"))
    with original.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    profile = next((entry for entry in profiles if entry["sha256"] == digest), None)
    if profile is None:
        raise ValueError("Unsupported original APK checksum")
    receipt = assemble_apk(original, assembled, addon_dex, certificate, output, profile["replacedDex"], profile["hookDex"], profile["addonDex"], wireless_only=wireless_only)
    print(json.dumps({"original_sha256_verified": True, "versionName": profile["versionName"], **receipt}))


if __name__ == "__main__":
    main()
