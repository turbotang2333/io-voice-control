import importlib.util
import os
from pathlib import Path

if os.getuid() != 0 or not Path('/etc/rayneo-isolated-systemd-test-only').exists():
    raise RuntimeError('ISOLATION_REQUIRED')
source = Path(__file__).resolve().parents[2] / 'relay' / 'self-hosted-runtime.py'
spec = importlib.util.spec_from_file_location('runtime', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = module.ensure_node()
if not result.startswith('/opt/rayneo_runtime/'):
    raise RuntimeError('ISOLATED_DOWNLOAD_NOT_USED')
print('ISOLATED_NODE_DOWNLOAD_AND_HASH_OK')
