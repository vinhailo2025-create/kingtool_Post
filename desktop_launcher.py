import atexit
import ctypes
import logging
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import traceback
import types
from pathlib import Path
from typing import Optional
from urllib.request import urlopen
from ctypes import wintypes

import webview


APP_NAME = "CovergemAuto"
DEFAULT_PORT = 3004
LOG_FILE = "desktop-launcher.log"


def app_root() -> Path:
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        candidates = [
            exe_dir,
            exe_dir.parent / "Resources",
            exe_dir.parent.parent / "Resources",
        ]
    else:
        candidates = [Path(__file__).resolve().parent]

    for candidate in candidates:
        if (candidate / "server.js").exists():
            return candidate

    return candidates[0]


def find_free_port(preferred: int = DEFAULT_PORT) -> int:
    for port in [preferred, 3000, 3001, 3002, 3003, 3005]:
        if is_port_free(port):
            return port

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def is_port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex(("127.0.0.1", port)) != 0


def node_executable(root: Path) -> str:
    bundled = root / "bin" / ("node.exe" if os.name == "nt" else "node")
    if bundled.exists():
        return str(bundled)

    found = shutil.which("node")
    if found:
        return found

    raise RuntimeError(
        "Khong tim thay Node.js. Hay build lai voi Node duoc bundle hoac cai Node.js tren may."
    )


def wait_for_server(url: str, process: subprocess.Popen, timeout: int = 30) -> None:
    start = time.time()
    last_error = None

    while time.time() - start < timeout:
        if process.poll() is not None:
            raise RuntimeError("Server Node da dung truoc khi app mo giao dien.")

        try:
            with urlopen(url, timeout=1) as response:
                if response.status < 500:
                    return
        except Exception as err:
            last_error = err

        time.sleep(0.35)

    raise RuntimeError(f"Khong ket noi duoc server local: {last_error}")


def stop_process(process: Optional[subprocess.Popen]) -> None:
    if not process or process.poll() is not None:
        return

    if os.name == "nt":
        process.terminate()
    else:
        process.send_signal(signal.SIGTERM)

    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()


def start_node_server(root: Path, port: int) -> subprocess.Popen:
    env = os.environ.copy()
    env["PORT"] = str(port)
    env["AUTO_OPEN_BROWSER"] = "0"
    env["COVERGEMAUTO_DESKTOP"] = "1"
    # Keep DB, Chrome profiles and uploads outside dist so exe and local runs share the same data.
    env["COVERGEMAUTO_DATA_DIR"] = str(root.parent.parent if root.name == "desktop_launcher.dist" else root)
    env.setdefault("NODE_ENV", "production")

    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NO_WINDOW

    return subprocess.Popen(
        [node_executable(root), "server.js"],
        cwd=str(root),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )


def write_log(root: Path, message: str) -> None:
    try:
        with (root / LOG_FILE).open("a", encoding="utf-8") as file:
            file.write(message.rstrip() + "\n")
    except Exception:
        pass


def install_win32_webview_shim() -> None:
    if "webview.platforms.win32" in sys.modules:
        return

    module = types.ModuleType("webview.platforms.win32")
    module._log = logging.getLogger("pywebview")
    module._user32 = ctypes.windll.user32

    class DEVMODE(ctypes.Structure):
        _fields_ = [
            ("dmDeviceName", wintypes.WCHAR * 32),
            ("dmSpecVersion", wintypes.WORD),
            ("dmDriverVersion", wintypes.WORD),
            ("dmSize", wintypes.WORD),
            ("dmDriverExtra", wintypes.WORD),
            ("dmFields", wintypes.DWORD),
            ("dmPositionX", wintypes.LONG),
            ("dmPositionY", wintypes.LONG),
            ("dmDisplayOrientation", wintypes.DWORD),
            ("dmDisplayFixedOutput", wintypes.DWORD),
            ("dmColor", wintypes.SHORT),
            ("dmDuplex", wintypes.SHORT),
            ("dmYResolution", wintypes.SHORT),
            ("dmTTOption", wintypes.SHORT),
            ("dmCollate", wintypes.SHORT),
            ("dmFormName", wintypes.WCHAR * 32),
            ("dmLogPixels", wintypes.WORD),
            ("dmBitsPerPel", wintypes.DWORD),
            ("dmPelsWidth", wintypes.DWORD),
            ("dmPelsHeight", wintypes.DWORD),
            ("dmDisplayFlags", wintypes.DWORD),
            ("dmDisplayFrequency", wintypes.DWORD),
            ("dmICMMethod", wintypes.DWORD),
            ("dmICMIntent", wintypes.DWORD),
            ("dmMediaType", wintypes.DWORD),
            ("dmDitherType", wintypes.DWORD),
            ("dmReserved1", wintypes.DWORD),
            ("dmReserved2", wintypes.DWORD),
            ("dmPanningWidth", wintypes.DWORD),
            ("dmPanningHeight", wintypes.DWORD),
        ]

    class DISPLAY_DEVICEW(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("DeviceName", wintypes.WCHAR * 32),
            ("DeviceString", wintypes.WCHAR * 128),
            ("StateFlags", wintypes.DWORD),
            ("DeviceID", wintypes.WCHAR * 128),
            ("DeviceKey", wintypes.WCHAR * 128),
        ]

    def get_screen_scale(device_name: str, logical_width: int, logical_height: int) -> float:
        try:
            dm = DEVMODE()
            dm.dmSize = ctypes.sizeof(DEVMODE)
            if module._user32.EnumDisplaySettingsW(device_name, -1, ctypes.byref(dm)):
                physical_width = dm.dmPelsWidth
            else:
                return 1.0
            return physical_width / logical_width if logical_width > 0 and logical_height > 0 else 1.0
        except Exception as err:
            module._log.debug(f"Failed to get display settings: {err}")
            return 1.0

    module.DEVMODE = DEVMODE
    module.DISPLAY_DEVICEW = DISPLAY_DEVICEW
    module.get_screen_scale = get_screen_scale
    sys.modules["webview.platforms.win32"] = module


def preload_windows_webview(root: Path) -> None:
    if os.name != "nt":
        return

    try:
        install_win32_webview_shim()
        import clr  # noqa: F401
        import pythonnet  # noqa: F401
        import webview.platforms.edgechromium  # noqa: F401
        import webview.platforms.winforms  # noqa: F401
    except Exception:
        write_log(root, "Windows webview preload failed:")
        write_log(root, traceback.format_exc())
        raise


def main() -> None:
    root = app_root()
    write_log(root, f"{APP_NAME} launcher starting from {root}")
    preload_windows_webview(root)
    port = find_free_port()
    url = f"http://127.0.0.1:{port}"
    server_process = start_node_server(root, port)
    atexit.register(stop_process, server_process)

    wait_for_server(url, server_process)

    window = webview.create_window(
        APP_NAME,
        url,
        width=1320,
        height=860,
        min_size=(1100, 720),
        confirm_close=True,
    )

    try:
        if os.name == "nt":
            webview.start(gui="edgechromium", debug=False)
        else:
            webview.start(debug=False)
    finally:
        stop_process(server_process)


if __name__ == "__main__":
    root_for_log = app_root()
    try:
        main()
    except Exception:
        write_log(root_for_log, traceback.format_exc())
        raise
