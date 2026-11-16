"""FANUC FOCAS2 definitions for ctypes, plus a thin `Fwlib` wrapper.

Written from the FOCAS2 documentation and the public fwlib32.h header. The library itself is
licensed from FANUC and is NOT in this repository.

Everything marked `# VERIFY ON MACHINE` must be checked against the real 0i-TF on the first day
(see docs/focas-notes.md). Struct layouts here are the Series 30i/31i/32i/0i-D/0i-F variants.

Integer sizes: FOCAS headers use C `short` (16 bit) and `long`. We use ctypes.c_long so the size
matches the C compiler that built the library on this platform (4 bytes on Windows and 32-bit
Linux; 8 bytes on 64-bit Linux builds of fwlib).  # VERIFY ON MACHINE for 64-bit Linux builds.
"""

import ctypes as C
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------- return codes

EW_PROTOCOL = -17
EW_SOCKET = -16
EW_NODLL = -15
EW_BUS = -11
EW_SYSTEM2 = -10
EW_HSSB = -9
EW_HANDLE = -8
EW_VERSION = -7
EW_UNEXP = -6
EW_SYSTEM = -5
EW_PARITY = -4
EW_MMCSYS = -3
EW_RESET = -2
EW_BUSY = -1
EW_OK = 0
EW_FUNC = 1  # also EW_NOPMC
EW_LENGTH = 2
EW_NUMBER = 3  # also EW_RANGE
EW_ATTRIB = 4  # also EW_TYPE
EW_DATA = 5
EW_NOOPT = 6
EW_PROT = 7
EW_OVRFLOW = 8
EW_PARAM = 9
EW_BUFFER = 10
EW_PATH = 11
EW_MODE = 12
EW_REJECT = 13
EW_DTSRVR = 14
EW_ALARM = 15
EW_STOP = 16
EW_PASSWD = 17

EW_MESSAGES: dict[int, str] = {
    EW_PROTOCOL: "communication protocol error",
    EW_SOCKET: "network socket error (cable, IP address, or the machine is off)",
    EW_NODLL: "FOCAS library for this controller series is missing",
    EW_BUS: "bus error",
    EW_SYSTEM2: "controller system error",
    EW_HSSB: "HSSB communication error",
    EW_HANDLE: "connection handle is no longer valid",
    EW_VERSION: "controller / library version mismatch",
    EW_UNEXP: "unexpected controller error",
    EW_SYSTEM: "controller system error",
    EW_PARITY: "shared RAM parity error",
    EW_MMCSYS: "FOCAS system error",
    EW_RESET: "the machine was reset during the operation",
    EW_BUSY: "the controller is busy",
    EW_FUNC: "function not available (or PMC not present)",
    EW_LENGTH: "data length error",
    EW_NUMBER: "number out of range (program, parameter or address)",
    EW_ATTRIB: "data type / attribute error",
    EW_DATA: "data error (program missing, already exists, or invalid)",
    EW_NOOPT: "the required option is not installed on this controller",
    EW_PROT: "memory is write-protected (program protect key or parameter)",
    EW_OVRFLOW: "controller memory is full",
    EW_PARAM: "controller parameter prevents this",
    EW_BUFFER: "controller buffer is busy, retry",
    EW_PATH: "path or folder error",
    EW_MODE: "the machine is in the wrong mode for this",
    EW_REJECT: "the controller rejected the request (running or alarm)",
    EW_DTSRVR: "data server error",
    EW_ALARM: "the machine has an alarm",
    EW_STOP: "the machine is stopped or in emergency",
    EW_PASSWD: "the program is locked by a password",
}

LIBRARY_NOT_FOUND = "FOCAS library not found – obtain Fwlib from FANUC/machine supplier"

# ---------------------------------------------------------------- structures


class ODBST(C.Structure):
    """cnc_statinfo for Series 30i/31i/32i/0i-D/0i-F.  # VERIFY ON MACHINE (0i-TF layout)"""

    _fields_ = [
        ("hdck", C.c_short),
        ("tmmode", C.c_short),
        (
            "aut",
            C.c_short,
        ),  # 0 MDI,1 MEM,2 ****,3 EDIT,4 HND,5 JOG,6 TJOG,7 THND,8 INC,9 REF,10 RMT
        ("run", C.c_short),  # 0 ****(reset),1 STOP,2 HOLD,3 STRT,4 MSTR
        ("motion", C.c_short),
        ("mstb", C.c_short),
        ("emergency", C.c_short),  # 0 none,1 EMerGency,2 ReSET,3 WAIT
        ("alarm", C.c_short),  # 0 none,1 ALaRM,2 BATtery low,3 FAN,...
        ("edit", C.c_short),
    ]


class ODBPRO(C.Structure):
    """cnc_rdprgnum: data = running program, mdata = main program."""

    # Verified on the 0i-TF of 55-04927 (16 Nov 2026): data and mdata are 2-byte shorts. Read as
    # longs, main program O9999 came out as 655294464 (= 9999 << 16).
    _fields_ = [("dummy", C.c_short * 2), ("data", C.c_short), ("mdata", C.c_short)]


class ODBSEQ(C.Structure):
    _fields_ = [("dummy", C.c_short * 2), ("data", C.c_long)]


class ODBACT(C.Structure):
    """cnc_acts: actual spindle speed (rpm)."""

    _fields_ = [("dummy", C.c_short * 2), ("data", C.c_long)]


class ODBALMMSG2(C.Structure):
    """cnc_rdalmmsg2.  # VERIFY ON MACHINE (message length 64 on 0i-F)"""

    _fields_ = [
        ("alm_no", C.c_long),
        ("type", C.c_short),
        ("axis", C.c_short),
        ("dummy", C.c_short),
        ("msg_len", C.c_short),
        ("alm_msg", C.c_char * 64),
    ]


class PRGDIR3_DATE(C.Structure):  # noqa: N801  (FANUC name)
    _fields_ = [
        ("year", C.c_short),
        ("month", C.c_short),
        ("day", C.c_short),
        ("hour", C.c_short),
        ("minute", C.c_short),
        ("dummy", C.c_short),
    ]


class PRGDIR3(C.Structure):
    """cnc_rdprogdir3 entry.  # VERIFY ON MACHINE (comment length 52)"""

    _fields_ = [
        ("number", C.c_long),
        ("length", C.c_long),
        ("page", C.c_long),
        ("comment", C.c_char * 52),
        ("mdate", PRGDIR3_DATE),
        ("cdate", PRGDIR3_DATE),
    ]


class _PSD_U(C.Union):  # noqa: N801
    _fields_ = [("cdata", C.c_char), ("idata", C.c_short), ("ldata", C.c_long)]


class IODBPSD(C.Structure):
    """cnc_rdparam, single non-axis parameter (byte / word / 2-word)."""

    _fields_ = [("datano", C.c_short), ("type", C.c_short), ("u", _PSD_U)]


class _PMC_U(C.Union):  # noqa: N801
    _fields_ = [("cdata", C.c_ubyte * 5), ("idata", C.c_short * 5), ("ldata", C.c_long * 5)]


class IODBPMC(C.Structure):
    """pmc_rdpmcrng / pmc_wrpmcrng. Header is 8 bytes; length = 8 + number of data bytes."""

    _fields_ = [
        ("type_a", C.c_short),
        ("type_d", C.c_short),
        ("datano_s", C.c_ushort),
        ("datano_e", C.c_ushort),
        ("u", _PMC_U),
    ]


# PMC address letters -> FOCAS adr_type.  # VERIFY ON MACHINE (0i-F PMC)
PMC_ADDRESS_TYPES = {"G": 0, "F": 1, "Y": 2, "X": 3, "A": 4, "R": 5, "T": 6, "K": 7, "C": 8, "D": 9}
PMC_BYTE = 0


@dataclass(frozen=True)
class PmcBit:
    letter: str
    number: int
    bit: int

    @property
    def adr_type(self) -> int:
        return PMC_ADDRESS_TYPES[self.letter]


def parse_pmc_bit(addr: str) -> PmcBit:
    """'R0100.0' -> PmcBit('R', 100, 0)."""
    a = addr.strip().upper()
    try:
        letter, rest = a[0], a[1:]
        num_s, bit_s = rest.split(".")
        pb = PmcBit(letter, int(num_s), int(bit_s))
    except (IndexError, ValueError) as e:
        raise ValueError(f"'{addr}' is not a PMC bit address (example: R0100.0)") from e
    if letter not in PMC_ADDRESS_TYPES or not 0 <= pb.bit <= 7 or pb.number < 0:
        raise ValueError(f"'{addr}' is not a valid PMC bit address")
    return pb


# ---------------------------------------------------------------- prototypes

_US = C.c_ushort
_S = C.c_short
_PROTOTYPES: dict[str, list[Any]] = {
    "cnc_allclibhndl3": [C.c_char_p, _US, C.c_long, C.POINTER(_US)],
    "cnc_freelibhndl": [_US],
    "cnc_statinfo": [_US, C.POINTER(ODBST)],
    "cnc_rdprgnum": [_US, C.POINTER(ODBPRO)],
    "cnc_rdseqnum": [_US, C.POINTER(ODBSEQ)],
    "cnc_alarm2": [_US, C.POINTER(C.c_long)],
    "cnc_rdalmmsg2": [_US, _S, C.POINTER(_S), C.POINTER(ODBALMMSG2)],
    "cnc_acts": [_US, C.POINTER(ODBACT)],
    "cnc_rdparam": [_US, _S, _S, _S, C.POINTER(IODBPSD)],
    "cnc_rdprogdir3": [_US, _S, C.POINTER(C.c_long), C.POINTER(_S), C.POINTER(PRGDIR3)],
    "cnc_upstart4": [_US, _S, C.c_char_p],
    "cnc_upload4": [_US, C.POINTER(C.c_long), C.c_char_p],
    "cnc_upend4": [_US],
    "cnc_dwnstart4": [_US, _S, C.c_char_p],
    "cnc_download4": [_US, C.POINTER(C.c_long), C.c_char_p],
    "cnc_dwnend4": [_US],
    "cnc_pdf_del": [_US, C.c_char_p],
    "cnc_pdf_slctmain": [_US, C.c_char_p],
    "pmc_rdpmcrng": [_US, _S, _S, _US, _US, _US, C.POINTER(IODBPMC)],
    "pmc_wrpmcrng": [_US, _US, C.POINTER(IODBPMC)],
}
# Linux library only: process-wide start-up / shutdown.  # VERIFY ON MACHINE
_LINUX_STARTUP = "cnc_startupprocess"


class FocasLibraryNotFound(RuntimeError):
    def __init__(self, path: str | None) -> None:
        where = f" (looked for: {path})" if path else " (focas_library_path is not set)"
        super().__init__(LIBRARY_NOT_FOUND + where)


class FocasError(Exception):
    """A FOCAS call returned an error code."""

    def __init__(self, function: str, code: int) -> None:
        self.function = function
        self.code = code
        meaning = EW_MESSAGES.get(code, "unknown error")
        super().__init__(f"Machine communication error: {meaning} ({function} returned {code}).")


def configure_prototypes(lib: Any) -> None:
    for name, argtypes in _PROTOTYPES.items():
        fn = getattr(lib, name, None)
        if fn is None:
            continue  # older library builds may lack pdf_* functions
        fn.argtypes = argtypes
        fn.restype = C.c_short


def load_library(path: str | None) -> Any:
    """Load Fwlib32.dll / Fwlib64.dll / libfwlib32.so from an explicit path."""
    if not path or not Path(path).is_file():
        raise FocasLibraryNotFound(path)
    try:
        if sys.platform == "win32":
            # Fwlib64.dll loads its companions (fwlibe64.dll for Ethernet, fwlib30i64.dll for the
            # 0i-F series...) by name at connect time: let Windows find them next to it.
            folder = str(Path(path).resolve().parent)
            os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")
            os.add_dll_directory(folder)  # type: ignore[attr-defined,unused-ignore]
            # stdcall on 32-bit Windows; on 64-bit WinDLL and CDLL are the same.
            lib = C.WinDLL(path)  # type: ignore[attr-defined,unused-ignore]  # Windows only
        else:
            lib = C.CDLL(path)
    except OSError as e:
        hint = ""
        if sys.platform == "win32" and "32" in Path(path).name and C.sizeof(C.c_void_p) == 8:
            hint = " Fwlib32.dll needs 32-bit Python; use Fwlib64.dll with 64-bit Python."
        raise FocasLibraryNotFound(f"{path}: {e}.{hint}") from e
    configure_prototypes(lib)
    startup = getattr(lib, _LINUX_STARTUP, None)
    if startup is not None and sys.platform != "win32":
        log = os.environ.get("MANUFAI_FOCAS_LOG", "focas.log")
        startup.argtypes = [C.c_long, C.c_char_p]
        startup.restype = C.c_short
        startup(0, log.encode())
    return lib


# ---------------------------------------------------------------- wrapper


class Fwlib:
    """Calls into the FOCAS library and raises FocasError on any non-OK return code.

    Not thread-safe: the driver calls it from ONE worker thread only.
    """

    def __init__(self, lib: Any) -> None:
        self.lib = lib

    def call(self, name: str, *args: Any, ok: tuple[int, ...] = (EW_OK,)) -> int:
        ret = int(getattr(self.lib, name)(*args))
        if ret not in ok:
            raise FocasError(name, ret)
        return ret

    def allclibhndl3(self, ip: str, port: int, timeout_s: int) -> int:
        h = C.c_ushort(0)
        self.call("cnc_allclibhndl3", ip.encode("ascii"), port, timeout_s, C.byref(h))
        return int(h.value)

    def freelibhndl(self, h: int) -> None:
        self.call("cnc_freelibhndl", h)

    def statinfo(self, h: int) -> ODBST:
        st = ODBST()
        self.call("cnc_statinfo", h, C.byref(st))
        return st

    def rdprgnum(self, h: int) -> ODBPRO:
        p = ODBPRO()
        self.call("cnc_rdprgnum", h, C.byref(p))
        return p

    def rdseqnum(self, h: int) -> int:
        s = ODBSEQ()
        self.call("cnc_rdseqnum", h, C.byref(s))
        return int(s.data)

    def alarm2(self, h: int) -> int:
        bits = C.c_long(0)
        self.call("cnc_alarm2", h, C.byref(bits))
        return int(bits.value)

    def rdalmmsg2(self, h: int, max_count: int = 10) -> list[tuple[int, str]]:
        num = C.c_short(max_count)
        arr = (ODBALMMSG2 * max_count)()
        self.call("cnc_rdalmmsg2", h, -1, C.byref(num), arr)
        out = []
        for i in range(min(num.value, max_count)):
            a = arr[i]
            msg = bytes(a.alm_msg)[: max(0, a.msg_len)].decode("ascii", errors="replace")
            out.append((int(a.alm_no), msg.strip()))
        return out

    def acts(self, h: int) -> int:
        a = ODBACT()
        self.call("cnc_acts", h, C.byref(a))
        return int(a.data)

    def rdparam_word(self, h: int, number: int) -> int:
        """Read a non-axis parameter (2-word). Used for part count, param 6711."""
        p = IODBPSD()
        self.call("cnc_rdparam", h, number, 0, 4 + C.sizeof(C.c_long), C.byref(p))
        return int(p.u.ldata)

    def rdprogdir3(self, h: int, top: int, count: int) -> list[tuple[int, int, str]]:
        top_c = C.c_long(top)
        num = C.c_short(count)
        arr = (PRGDIR3 * count)()
        self.call("cnc_rdprogdir3", h, 1, C.byref(top_c), C.byref(num), arr)
        out = []
        for i in range(min(num.value, count)):
            e = arr[i]
            comment = bytes(e.comment).split(b"\0", 1)[0].decode("ascii", errors="replace")
            out.append((int(e.number), int(e.length), comment.strip().strip("()")))
        return out

    def upload(
        self, h: int, path: str, sleep: Callable[[float], None], max_bytes: int = 4_000_000
    ) -> str:
        self.call("cnc_upstart4", h, 0, path.encode("ascii"))
        chunks: list[bytes] = []
        total = 0
        try:
            while True:
                buf = C.create_string_buffer(1280)
                length = C.c_long(1280)
                ret = self.call("cnc_upload4", h, C.byref(length), buf, ok=(EW_OK, EW_BUFFER))
                if ret == EW_BUFFER:
                    sleep(0.01)
                    continue
                data = buf.raw[: length.value]
                chunks.append(data)
                total += len(data)
                text_so_far = b"".join(chunks).rstrip(b"\r\n ")
                # Data ends with the closing '%' (the first chunk may also start with '%').
                if len(text_so_far) > 1 and text_so_far.endswith(b"%"):
                    break
                if total > max_bytes:
                    raise FocasError("cnc_upload4", EW_OVRFLOW)
        finally:
            self.lib.cnc_upend4(h)
        return b"".join(chunks).decode("ascii", errors="replace")

    def download(
        self, h: int, folder: str, data: bytes, sleep: Callable[[float], None], chunk: int = 256
    ) -> None:
        self.call("cnc_dwnstart4", h, 0, folder.encode("ascii"))
        pos = 0
        try:
            while pos < len(data):
                piece = data[pos : pos + chunk]
                length = C.c_long(len(piece))
                ret = self.call("cnc_download4", h, C.byref(length), piece, ok=(EW_OK, EW_BUFFER))
                if ret == EW_BUFFER:
                    sleep(0.01)
                    continue
                pos += max(1, int(length.value))
        except FocasError:
            self.lib.cnc_dwnend4(h)
            raise
        # dwnend reports errors found in the program (e.g. EW_DATA: number already exists).
        self.call("cnc_dwnend4", h)

    def pdf_del(self, h: int, path: str) -> None:
        self.call("cnc_pdf_del", h, path.encode("ascii"))

    def pdf_slctmain(self, h: int, path: str) -> None:
        self.call("cnc_pdf_slctmain", h, path.encode("ascii"))

    def pmc_read_byte(self, h: int, adr_type: int, number: int) -> int:
        buf = IODBPMC()
        self.call("pmc_rdpmcrng", h, adr_type, PMC_BYTE, number, number, 8 + 1, C.byref(buf))
        return int(buf.u.cdata[0])

    def pmc_write_byte(self, h: int, adr_type: int, number: int, value: int) -> None:
        buf = IODBPMC()
        buf.type_a = adr_type
        buf.type_d = PMC_BYTE
        buf.datano_s = number
        buf.datano_e = number
        buf.u.cdata[0] = value & 0xFF
        self.call("pmc_wrpmcrng", h, 8 + 1, C.byref(buf))
