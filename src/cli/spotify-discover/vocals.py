"""Measure how much voice a song preview has, with Demucs (htdemucs).

Usage: python -I vocals.py <jobs.json>
jobs.json is a list of {"id": ..., "wav": <path to a 44.1 kHz WAV>}.
Prints one JSON line per job: {"id", "maxDb", "p90Db"} or {"id", "error"}.

For each second of the preview, the vocal stem's RMS is compared with the
whole mix's RMS there, in dB (0 dB = all of it is voice). Quiet seconds of
the mix are skipped, so a silent intro cannot look vocal. Demucs lets some
synth leads bleed into the vocal stem, which is why the threshold comes from
calibration on songs known to be instrumental and known to be sung.
"""
import json
import sys

import numpy as np
import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model


def main() -> None:
    jobs = json.load(open(sys.argv[1]))
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = get_model("htdemucs")
    model.to(device)
    model.eval()
    vocal_index = model.sources.index("vocals")
    rate = model.samplerate
    for job in jobs:
        try:
            audio, sr = sf.read(job["wav"], dtype="float32", always_2d=True)
            if sr != rate:
                raise ValueError(f"sample rate {sr}, wanted {rate}")
            if audio.shape[1] == 1:
                audio = np.repeat(audio, 2, axis=1)
            mix = torch.from_numpy(audio[:, :2].T.copy())
            ref = mix.mean(0)
            mean, std = ref.mean(), ref.std() + 1e-8
            with torch.no_grad():
                sources = apply_model(model, ((mix - mean) / std)[None].to(device), device=device, split=True, overlap=0.25, progress=False)[0]
            vocals = (sources[vocal_index].cpu() * std + mean).mean(0).numpy()
            whole = mix.mean(0).numpy()
            secs = len(whole) // rate
            ratios = []
            mix_levels = []
            for s in range(secs):
                seg = slice(s * rate, (s + 1) * rate)
                mix_rms = float(np.sqrt(np.mean(whole[seg] ** 2)) + 1e-9)
                voc_rms = float(np.sqrt(np.mean(vocals[seg] ** 2)) + 1e-9)
                mix_levels.append(mix_rms)
                ratios.append(20 * np.log10(voc_rms / mix_rms))
            loud = max(mix_levels) if mix_levels else 0
            kept = [r for r, m in zip(ratios, mix_levels) if m > loud * 0.1] or ratios
            kept.sort()
            p90 = kept[int(round((len(kept) - 1) * 0.9))]
            print(json.dumps({"id": job["id"], "maxDb": round(kept[-1], 2), "p90Db": round(p90, 2)}), flush=True)
        except Exception as err:  # one bad file must not stop the rest
            print(json.dumps({"id": job["id"], "error": str(err)[:200]}), flush=True)


if __name__ == "__main__":
    main()
