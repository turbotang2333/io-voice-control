"""Prepare an isolated Node runtime without overwriting an existing installation."""
import hashlib
import io
import os
import platform
import posixpath
import re
import secrets
import shutil
import stat
import subprocess
import tarfile
import urllib.request
from pathlib import Path

VERSION = "v22.23.4"
# Node.js release checksums: https://nodejs.org/en/blog/release/v22.23.4/
CHECKSUMS = {
    "x64": "1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce",
    "arm64": "6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b",
}


def install_verified_archive(data, expected, arch, target):
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("NODE_CHECKSUM_FAILED")
    name = f"node-{VERSION}-linux-{arch}/bin/node"
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as archive:
        member = archive.getmember(name)
        if not member.isfile() or member.size <= 0 or member.size > 200_000_000:
            raise ValueError("NODE_ARCHIVE_INVALID")
        content = archive.extractfile(member).read()
    target = Path(target)
    temporary = target.with_name(target.name + "." + secrets.token_hex(12))
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(temporary, flags, 0o755)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o755)
        try:
            os.link(temporary, target)
        except FileExistsError:
            st = target.lstat()
            if (not stat.S_ISREG(st.st_mode) or os.name == 'posix' and (st.st_uid != os.geteuid() or st.st_mode & 0o022 or not st.st_mode & 0o111)
                    or hashlib.sha256(target.read_bytes()).digest() != hashlib.sha256(content).digest()):
                raise ValueError("NODE_RUNTIME_CONFLICT")
    finally:
        temporary.unlink(missing_ok=True)
    return str(target)


def secure_directory(path):
    try:
        os.mkdir(path, 0o755)
    except FileExistsError:
        pass
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError("NODE_DIRECTORY_UNSAFE")


def service_runtime_path(path):
    return bool(re.fullmatch(r"/[A-Za-z0-9_./]+", path)) and ".." not in path and not path.startswith(('/home/', '/root/', '/tmp/', '/run/'))


def trusted_node_path(path):
    if not service_runtime_path(path):
        return False
    current = path
    first = True
    try:
        while True:
            info = os.lstat(current)
            if info.st_uid != 0 or info.st_mode & 0o022:
                return False
            if first and (not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o111):
                return False
            if not first and not stat.S_ISDIR(info.st_mode):
                return False
            if current == '/':
                return True
            current = posixpath.dirname(current)
            first = False
    except OSError:
        return False


def ensure_node():
    node = shutil.which("node")
    if node:
        try:
            resolved = os.path.realpath(node)
            if trusted_node_path(resolved):
                output = subprocess.check_output([resolved, "--version"], text=True, timeout=10).strip()
                if int(output.lstrip("v").split(".")[0]) >= 22:
                    return resolved
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    arch = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine().lower())
    if not arch:
        raise ValueError("NODE_ARCH_UNSUPPORTED")
    print("正在下载并校验 Node.js 运行环境，请稍候。", flush=True)
    name = f"node-{VERSION}-linux-{arch}.tar.xz"
    urls = [f"https://nodejs.org/dist/{VERSION}/{name}", f"https://mirrors.huaweicloud.com/repository/toolkit/nodejs/{VERSION}/{name}"]
    data = None
    for url in urls:
        try:
            with urllib.request.urlopen(url, timeout=45) as response:
                candidate = response.read(100_000_001)
            if len(candidate) <= 100_000_000 and hashlib.sha256(candidate).hexdigest() == CHECKSUMS[arch]:
                data = candidate
                break
        except Exception:
            continue
    if data is None:
        raise ValueError("NODE_DOWNLOAD_FAILED")
    secure_directory(Path("/opt"))
    base = Path("/opt/rayneo_runtime")
    secure_directory(base)
    version_directory = base / (VERSION + "_" + arch)
    secure_directory(version_directory)
    result = install_verified_archive(data, CHECKSUMS[arch], arch, version_directory / "node")
    if not trusted_node_path(result):
        raise ValueError("NODE_RUNTIME_UNSAFE")
    return result
