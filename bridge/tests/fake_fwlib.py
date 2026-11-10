"""A fake FOCAS library that behaves like the C functions (byref args, raw buffers).

Lets the ctypes wrapper and FocasDriver be tested without the licensed DLL or a machine.
"""

import ctypes as C
import re
import threading
from typing import Any

from bridge.focas_ctypes import EW_BUFFER, EW_DATA, EW_OK, EW_SOCKET

CRLF_PROGRAM = "%\r\nO0001(FAKE PART)\r\nG28U0W0\r\nG0X10.0Z2.0\r\nM30\r\n%"


def _obj(ref: Any) -> Any:
    return ref._obj  # ctypes byref() -> underlying object


class FakeFwlib:
    def __init__(self) -> None:
        self.programs: dict[int, str] = {1: CRLF_PROGRAM}
        self.aut, self.run, self.emergency, self.alarm_field = 1, 0, 0, 0
        self.alarm_bits = 0
        self.alarm_list = [(1001, "SPINDLE OVERHEAT")]
        self.main_program, self.seq, self.spindle, self.parts = 1, 20, 1500, 42
        self.connect_failures = 0
        self.fail_next: dict[str, int] = {}
        self.buffer_busy_once: set[str] = set()
        self.upload_chunk = 13
        self.download_accept = 50
        self.pmc: dict[tuple[int, int], int] = {(0, 12): 0x9B}  # *FV = 0x9B -> override 100
        self.pmc_writes: list[tuple[int, int, int]] = []
        self.calls: list[str] = []
        self.threads: set[int] = set()
        self.handles_open = 0
        self._up = b""
        self._pos = 0
        self._down = b""

    # ---- helpers ----
    def _enter(self, name: str) -> int | None:
        self.calls.append(name)
        self.threads.add(threading.get_ident())
        if name in self.fail_next:
            return self.fail_next.pop(name)
        if name in self.buffer_busy_once:
            self.buffer_busy_once.discard(name)
            return EW_BUFFER
        return None

    @staticmethod
    def _number(path: bytes) -> int:
        m = re.search(rb"O(\d{4})$", path)
        return int(m.group(1)) if m else -1

    # ---- connection ----
    def cnc_allclibhndl3(self, ip: bytes, port: int, timeout: int, h: Any) -> int:
        if (r := self._enter("cnc_allclibhndl3")) is not None:
            return r
        if self.connect_failures > 0:
            self.connect_failures -= 1
            return EW_SOCKET
        _obj(h).value = 7
        self.handles_open += 1
        return EW_OK

    def cnc_freelibhndl(self, h: int) -> int:
        self._enter("cnc_freelibhndl")
        self.handles_open -= 1
        return EW_OK

    # ---- status ----
    def cnc_statinfo(self, h: int, ref: Any) -> int:
        if (r := self._enter("cnc_statinfo")) is not None:
            return r
        st = _obj(ref)
        st.aut, st.run, st.emergency, st.alarm = (
            self.aut,
            self.run,
            self.emergency,
            self.alarm_field,
        )
        return EW_OK

    def cnc_rdprgnum(self, h: int, ref: Any) -> int:
        self._enter("cnc_rdprgnum")
        _obj(ref).data = self.main_program
        _obj(ref).mdata = self.main_program
        return EW_OK

    def cnc_rdseqnum(self, h: int, ref: Any) -> int:
        self._enter("cnc_rdseqnum")
        _obj(ref).data = self.seq
        return EW_OK

    def cnc_alarm2(self, h: int, ref: Any) -> int:
        self._enter("cnc_alarm2")
        _obj(ref).value = self.alarm_bits
        return EW_OK

    def cnc_rdalmmsg2(self, h: int, typ: int, num: Any, arr: Any) -> int:
        self._enter("cnc_rdalmmsg2")
        n = min(len(self.alarm_list), _obj(num).value)
        for i in range(n):
            code, msg = self.alarm_list[i]
            arr[i].alm_no = code
            arr[i].alm_msg = msg.encode()
            arr[i].msg_len = len(msg)
        _obj(num).value = n
        return EW_OK

    def cnc_acts(self, h: int, ref: Any) -> int:
        self._enter("cnc_acts")
        _obj(ref).data = self.spindle
        return EW_OK

    def cnc_rdparam(self, h: int, number: int, axis: int, length: int, ref: Any) -> int:
        self._enter("cnc_rdparam")
        _obj(ref).datano = number
        _obj(ref).u.ldata = self.parts
        return EW_OK

    # ---- programs ----
    def cnc_rdprogdir3(self, h: int, typ: int, top: Any, num: Any, arr: Any) -> int:
        self._enter("cnc_rdprogdir3")
        numbers = [n for n in sorted(self.programs) if n >= _obj(top).value][: _obj(num).value]
        for i, n in enumerate(numbers):
            arr[i].number = n
            arr[i].length = len(self.programs[n])
            m = re.search(r"\((.*?)\)", self.programs[n])
            arr[i].comment = f"({m.group(1) if m else ''})".encode()
        _obj(num).value = len(numbers)
        return EW_OK

    def cnc_upstart4(self, h: int, typ: int, path: bytes) -> int:
        if (r := self._enter("cnc_upstart4")) is not None:
            return r
        n = self._number(path)
        if n not in self.programs:
            return EW_DATA
        self._up, self._pos = self.programs[n].encode(), 0
        return EW_OK

    def cnc_upload4(self, h: int, length: Any, buf: Any) -> int:
        if (r := self._enter("cnc_upload4")) is not None:
            return r
        n = min(_obj(length).value, self.upload_chunk)
        data = self._up[self._pos : self._pos + n]
        C.memmove(buf, data, len(data))
        _obj(length).value = len(data)
        self._pos += len(data)
        return EW_OK

    def cnc_upend4(self, h: int) -> int:
        self._enter("cnc_upend4")
        return EW_OK

    def cnc_dwnstart4(self, h: int, typ: int, folder: bytes) -> int:
        if (r := self._enter("cnc_dwnstart4")) is not None:
            return r
        self._down = b""
        return EW_OK

    def cnc_download4(self, h: int, length: Any, data: bytes) -> int:
        if (r := self._enter("cnc_download4")) is not None:
            return r
        n = min(_obj(length).value, self.download_accept)
        self._down += data[:n]
        _obj(length).value = n
        return EW_OK

    def cnc_dwnend4(self, h: int) -> int:
        if (r := self._enter("cnc_dwnend4")) is not None:
            return r
        m = re.search(rb"O(\d{4})", self._down)
        if not m:
            return EW_DATA
        n = int(m.group(1))
        if n in self.programs:
            return EW_DATA
        self.programs[n] = self._down.decode()
        return EW_OK

    def cnc_pdf_del(self, h: int, path: bytes) -> int:
        self._enter("cnc_pdf_del")
        n = self._number(path)
        if n not in self.programs:
            return EW_DATA
        del self.programs[n]
        return EW_OK

    def cnc_pdf_slctmain(self, h: int, path: bytes) -> int:
        self._enter("cnc_pdf_slctmain")
        n = self._number(path)
        if n not in self.programs:
            return EW_DATA
        self.main_program = n
        return EW_OK

    # ---- PMC ----
    def pmc_rdpmcrng(self, h: int, adr: int, dt: int, s: int, e: int, ln: int, ref: Any) -> int:
        self._enter("pmc_rdpmcrng")
        _obj(ref).u.cdata[0] = self.pmc.get((adr, s), 0)
        return EW_OK

    def pmc_wrpmcrng(self, h: int, ln: int, ref: Any) -> int:
        self._enter("pmc_wrpmcrng")
        o = _obj(ref)
        value = int(o.u.cdata[0])
        self.pmc[(o.type_a, o.datano_s)] = value
        self.pmc_writes.append((o.type_a, o.datano_s, value))
        return EW_OK
