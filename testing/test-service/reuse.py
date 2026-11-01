import importlib.util
from pathlib import Path


def load(name, folder, filename):
    local = Path(__file__).resolve().parents[1]
    installed = Path('/opt/reuse')
    root = installed if installed.exists() else local
    directory = {'system': 'system', 'can': 'can' if installed.exists() else 'can-server', 'modbus': 'modbus' if installed.exists() else 'krsps-master'}[folder]
    spec = importlib.util.spec_from_file_location(name, root/directory/filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
