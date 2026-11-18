"""Build backend/dist/playtopia-backend.exe with PyInstaller.

    pip install pyinstaller
    python backend/build_backend.py      (works from any directory)
"""

import importlib.util
import os

import PyInstaller.__main__

os.chdir(os.path.dirname(os.path.abspath(__file__)))

args = [
    'run_backend.py', '--onefile', '--name', 'playtopia-backend', '--noconfirm', '--clean',
    '--add-data', f'addons{os.pathsep}addons',
    '--hidden-import', 'mitmproxy', '--hidden-import', 'mitmproxy.tools.main',
    '--hidden-import', 'mitmproxy.tools.dump',
    '--hidden-import', 'websockets',
    '--collect-all', 'mitmproxy', '--collect-all', 'websockets',
]

# Native helpers used by newer mitmproxy releases (local capture mode, etc.).
for optional in ('mitmproxy_rs', 'mitmproxy_windows'):
    if importlib.util.find_spec(optional) is not None:
        args += ['--collect-all', optional]

PyInstaller.__main__.run(args)
