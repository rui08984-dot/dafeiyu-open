"""Small cross-thread and cross-process state helpers for the WebUI."""

import hashlib
import json
import os
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path


_LOCK_ROOT = Path(tempfile.gettempdir()) / "my-neuro-webui-locks"
_STATE_ROOT = Path(tempfile.gettempdir()) / "my-neuro-webui-state"
_THREAD_LOCKS = {}
_THREAD_LOCKS_GUARD = threading.Lock()


def _resource_key(resource):
    if isinstance(resource, Path):
        value = str(resource.resolve())
    else:
        value = str(resource)
    return os.path.normcase(value)


def _resource_digest(resource):
    return hashlib.sha256(_resource_key(resource).encode("utf-8")).hexdigest()


def _thread_lock(resource):
    key = _resource_key(resource)
    with _THREAD_LOCKS_GUARD:
        return _THREAD_LOCKS.setdefault(key, threading.RLock())


def _try_lock_file(stream):
    stream.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        return

    import fcntl

    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock_file(stream):
    stream.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        return

    import fcntl

    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


@contextmanager
def resource_lock(resource, timeout=15.0, poll_interval=0.025):
    """Serialize one logical resource across threads and WebUI processes."""
    thread_lock = _thread_lock(resource)
    with thread_lock:
        _LOCK_ROOT.mkdir(parents=True, exist_ok=True)
        lock_path = _LOCK_ROOT / f"{_resource_digest(resource)}.lock"
        with lock_path.open("a+b") as stream:
            stream.seek(0, os.SEEK_END)
            if stream.tell() == 0:
                stream.write(b"\0")
                stream.flush()

            deadline = time.monotonic() + timeout
            while True:
                try:
                    _try_lock_file(stream)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(
                            f"Timed out waiting for resource lock: {_resource_key(resource)}"
                        )
                    time.sleep(poll_interval)

            try:
                yield
            finally:
                _unlock_file(stream)


def json_payload_bytes(data, *, indent=2):
    """Serialize one JSON document exactly as it will be stored (single source of truth)."""
    text = json.dumps(data, ensure_ascii=False, indent=indent)
    return (text + "\n").encode("utf-8")


def verify_json_readback(path, expected_payload):
    """Read the file back and fail loudly when the bytes on disk differ.

    ``os.replace`` returning normally only proves the rename worked, not that the
    target holds the intended bytes (truncated write, AV rewrite, encoding
    mangling, a concurrent writer). Compare the whole-file SHA-256; callers treat
    the raised error as their normal save failure, so this must never be silent.
    """
    expected_payload = bytes(expected_payload)
    actual_payload = Path(path).read_bytes()
    expected_digest = hashlib.sha256(expected_payload).hexdigest()
    actual_digest = hashlib.sha256(actual_payload).hexdigest()
    if actual_digest != expected_digest:
        raise OSError(
            "JSON read-back mismatch for %s: expected sha256 %s (%d bytes), got %s (%d bytes)"
            % (path, expected_digest, len(expected_payload), actual_digest, len(actual_payload))
        )
    return True


def atomic_write_json(path, data, *, indent=2):
    """Atomic JSON write + read-back verification of the bytes that landed on disk."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Serialize before touching the filesystem: a non-serializable payload must fail
    # without leaving a temp file behind and without disturbing the target.
    payload = json_payload_bytes(data, indent=indent)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=target.parent,
            prefix=f".{target.name}.",
            suffix=".tmp",
            delete=False,
        ) as stream:
            temp_path = Path(stream.name)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, target)
        temp_path = None
        verify_json_readback(target, payload)
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink()
            except OSError:
                pass


def resource_state_path(resource):
    _STATE_ROOT.mkdir(parents=True, exist_ok=True)
    return _STATE_ROOT / f"{_resource_digest(resource)}.json"


def read_resource_state(resource):
    path = resource_state_path(resource)
    try:
        with path.open("r", encoding="utf-8") as stream:
            value = json.load(stream)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def write_resource_state(resource, data):
    atomic_write_json(resource_state_path(resource), data)


def delete_resource_state(resource):
    try:
        resource_state_path(resource).unlink()
    except FileNotFoundError:
        pass
