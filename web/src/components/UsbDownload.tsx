import { useState } from 'react';
import { ApiError, getToken } from '../api/client';

/** Approved program as O1234.NC for a USB stick (FANUC panel USB port). The server refuses
 *  anything that could not be sent over the network (not approved, not latest, changed). */
export default function UsbDownload({ programId, programName }: { programId: number; programName: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const token = getToken();
      const res = await fetch(`/api/programs/${programId}/file`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        let detail = `Download failed (${res.status})`;
        try {
          detail = ((await res.json()) as { detail?: string }).detail ?? detail;
        } catch {
          /* not JSON */
        }
        throw new ApiError(res.status, detail);
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${programName}.NC`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <button className="btn min-h-10" onClick={() => void download()} disabled={busy}>
        {busy ? 'Preparing…' : `Download ${programName}.NC for a USB stick`}
      </button>
      <p className="text-xs text-slate-600">
        No network yet? Copy the file to a USB stick and plug it into the CNC panel. In EDIT mode open the
        program list (PROG), switch the device to USB memory and read in {programName}.NC. Check the program
        number and the first lines on the screen before running.
      </p>
      {error && <p className="text-sm text-red-800">{error}</p>}
    </div>
  );
}
