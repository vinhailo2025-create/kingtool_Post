import atexit
import ctypes
import hashlib
import json
import logging
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
import types
import webbrowser
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse
from urllib.request import urlopen
from ctypes import wintypes

import webview


APP_NAME = "Super Post - King"
DEFAULT_PORT = 3004
LOG_FILE = "desktop-launcher.log"
SINGLE_INSTANCE_MUTEX = "Local\\KingAutomationAI.SuperPostKing"
ERROR_ALREADY_EXISTS = 183


def focus_existing_window() -> None:
    if os.name != "nt":
        return
    try:
        user32 = ctypes.windll.user32
        user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
        user32.FindWindowW.restype = wintypes.HWND
        window = user32.FindWindowW(None, APP_NAME)
        if window:
            user32.ShowWindow(window, 9)
            user32.SetForegroundWindow(window)
    except Exception:
        pass


def acquire_single_instance():
    if os.name != "nt":
        return True
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    mutex = kernel32.CreateMutexW(None, False, SINGLE_INSTANCE_MUTEX)
    if not mutex:
        raise ctypes.WinError()
    if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
        focus_existing_window()
        kernel32.CloseHandle(mutex)
        return None
    return mutex


def release_single_instance(mutex) -> None:
    if os.name == "nt" and mutex:
        ctypes.windll.kernel32.CloseHandle(mutex)


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


def user_data_root() -> Path:
    if sys.platform == "darwin":
        # macOS luu du lieu ung dung tai ~/Library/Application Support de dong bo
        # voi Agent Kit/MCP (start-mcp.sh doc agent-api-endpoint.json o day).
        base = Path.home() / "Library" / "Application Support"
    else:
        local_app_data = os.environ.get("LOCALAPPDATA")
        base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    root = base / "King Automation AI" / "Super Post King"
    for relative in ("logs", "webview", "uploads", "src/database", "src/chrome-profiles", "src/backups"):
        (root / relative).mkdir(parents=True, exist_ok=True)
    return root


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


def start_node_server(root: Path, data_root: Path, port: int) -> subprocess.Popen:
    env = os.environ.copy()
    env["PORT"] = str(port)
    env["AUTO_OPEN_BROWSER"] = "0"
    env["COVERGEMAUTO_DESKTOP"] = "1"
    env["COVERGEMAUTO_PARENT_PID"] = str(os.getpid())
    # User data must remain writable and survive upgrades/uninstall. Never store it in Program Files
    # or beside the executable, and never ship one customer's browser cookies to another customer.
    env["COVERGEMAUTO_DATA_DIR"] = str(data_root)
    env["WEBVIEW2_USER_DATA_FOLDER"] = str(data_root / "webview")
    env.setdefault("NODE_ENV", "production")

    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NO_WINDOW

    # Giu lai stderr cua Node trong logs/server.log de biet vi sao server chet.
    log_dir = data_root / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    stderr_target = subprocess.DEVNULL
    try:
        stderr_target = (log_dir / "server.log").open("a", encoding="utf-8", errors="replace")
    except Exception:
        pass

    return subprocess.Popen(
        [node_executable(root), "server.js"],
        cwd=str(root),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=stderr_target,
        creationflags=creationflags,
    )


class ServerSupervisor:
    """Khoi dong lai server Node neu no chet trong luc cua so app con mo."""

    def __init__(self, root: Path, data_root: Path, port: int, process: subprocess.Popen):
        self.root = root
        self.data_root = data_root
        self.port = port
        self.process = process
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="server-supervisor", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        stop_process(self.process)

    def _loop(self) -> None:
        restarts = 0
        while not self._stop.wait(2.0):
            code = self.process.poll()
            if code is None:
                continue
            restarts += 1
            write_log(self.data_root, f"Server Node exited with code {code}; restarting ({restarts})")
            if restarts > 5:
                write_log(self.data_root, "Server Node keeps exiting; giving up automatic restart.")
                return
            try:
                self.process = start_node_server(self.root, self.data_root, self.port)
                wait_for_server(f"http://127.0.0.1:{self.port}", self.process)
                write_log(self.data_root, f"Server Node restarted on port {self.port}")
            except Exception as err:
                write_log(self.data_root, f"Server Node restart failed: {err}")
                time.sleep(5)


def write_log(data_root: Path, message: str) -> None:
    try:
        log_dir = data_root / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        with (log_dir / LOG_FILE).open("a", encoding="utf-8") as file:
            file.write(message.rstrip() + "\n")
    except Exception:
        pass


class DesktopApi:
    def __init__(self, data_root: Path):
        self.data_root = data_root.resolve()
        self.update_installer: Optional[Path] = None

    def open_external_url(self, url: str):
        try:
            parsed = urlparse(str(url or "").strip())
            if parsed.scheme != "https" or (parsed.hostname or "").lower() not in {
                "kingautomationai.com",
                "www.kingautomationai.com",
            }:
                raise RuntimeError("Lien ket website khong hop le.")
            opened = webbrowser.open(parsed.geturl(), new=2)
            if not opened:
                raise RuntimeError("Khong mo duoc trinh duyet mac dinh.")
            return {"success": True}
        except Exception as err:
            write_log(self.data_root, f"External URL request failed: {err}")
            return {"success": False, "error": str(err)}

    def install_update(self):
        try:
            updates_root = (self.data_root / "updates").resolve()
            pending_path = updates_root / "pending-update.json"
            pending = json.loads(pending_path.read_text(encoding="utf-8"))
            installer = Path(str(pending.get("installer_path", ""))).resolve()
            expected_hash = str(pending.get("sha256", "")).strip().lower()

            if installer.parent != updates_root or installer.suffix.lower() != ".exe":
                raise RuntimeError("Duong dan installer khong hop le.")
            if not installer.is_file():
                raise RuntimeError("Khong tim thay installer da tai.")
            if len(expected_hash) != 64:
                raise RuntimeError("Checksum installer khong hop le.")

            digest = hashlib.sha256()
            with installer.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest().lower() != expected_hash:
                raise RuntimeError("Checksum installer khong khop.")

            self.update_installer = installer

            def close_window():
                try:
                    if webview.windows:
                        webview.windows[0].destroy()
                except Exception:
                    pass

            threading.Timer(0.35, close_window).start()
            return {"success": True}
        except Exception as err:
            write_log(self.data_root, f"Update install request failed: {err}")
            return {"success": False, "error": str(err)}


def launch_update_installer(installer: Path, data_root: Path) -> None:
    if os.name != "nt":
        return
    if not re.fullmatch(r"Super-Post-King-Setup-\d+\.\d+\.\d+\.exe", installer.name):
        raise RuntimeError("Ten installer cap nhat khong hop le.")

    # Keep all nested quoting out of CreateProcess: cmd.exe otherwise turns start ""
    # into a bogus \\ network path when the AppData directory contains spaces.
    helper = installer.parent / "run-super-post-update.cmd"
    helper_script = (
        "@echo off\n"
        "timeout /t 2 /nobreak >nul\n"
        f'"{installer.name}" /VERYSILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS /NORESTART\n'
        'set "update_exit=%errorlevel%"\n'
        'del /f /q "%~f0" >nul 2>&1\n'
        "exit /b %update_exit%\n"
    )
    helper.write_text(helper_script, encoding="ascii")

    shell32 = ctypes.windll.shell32
    shell32.ShellExecuteW.argtypes = [
        wintypes.HWND,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        ctypes.c_int,
    ]
    shell32.ShellExecuteW.restype = ctypes.c_void_p
    result = shell32.ShellExecuteW(
        None,
        "open",
        str(helper),
        None,
        str(installer.parent),
        0,
    )
    if not result or int(result) <= 32:
        raise ctypes.WinError(int(result or 0))
    write_log(data_root, f"Launching verified update installer via helper: {installer.name}")


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


def preload_windows_webview(data_root: Path) -> None:
    if os.name != "nt":
        return

    try:
        install_win32_webview_shim()
        import clr  # noqa: F401
        import pythonnet  # noqa: F401
        import webview.platforms.edgechromium  # noqa: F401
        import webview.platforms.winforms  # noqa: F401
    except Exception:
        write_log(data_root, "Windows webview preload failed:")
        write_log(data_root, traceback.format_exc())
        raise


def main() -> None:
    mutex = acquire_single_instance()
    if mutex is None:
        return
    try:
        root = app_root()
        data_root = user_data_root()
        write_log(data_root, f"{APP_NAME} launcher starting from {root}; data={data_root}")
        preload_windows_webview(data_root)
        port = find_free_port()
        url = f"http://127.0.0.1:{port}"
        server_process = start_node_server(root, data_root, port)
        desktop_api = DesktopApi(data_root)
        supervisor = ServerSupervisor(root, data_root, port, server_process)
        atexit.register(supervisor.stop)

        wait_for_server(url, server_process)
        supervisor.start()

        webview.create_window(
            APP_NAME,
            url,
            width=1320,
            height=860,
            min_size=(1100, 720),
            confirm_close=True,
            js_api=desktop_api,
        )

        try:
            if os.name == "nt":
                webview.start(gui="edgechromium", debug=False, private_mode=False, storage_path=str(data_root / "webview"))
            else:
                webview.start(debug=False)
        finally:
            supervisor.stop()
            if desktop_api.update_installer:
                launch_update_installer(desktop_api.update_installer, data_root)
    finally:
        release_single_instance(mutex)


if __name__ == "__main__":
    data_for_log = user_data_root()
    try:
        main()
    except Exception:
        write_log(data_for_log, traceback.format_exc())
        raise
