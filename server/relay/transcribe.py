"""Transcribe one M4A from stdin with a locally provisioned model."""

import io
import os
from pathlib import Path
import sys


os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

dll_path = os.environ.get("ASR_DLL_DIR")
dll_directory = os.add_dll_directory(dll_path) if os.name == "nt" and dll_path else None

import av
from faster_whisper import WhisperModel
import numpy as np
import onnxruntime
from opencc import OpenCC


MAX_BYTES = 4 * 1024 * 1024
SAMPLE_RATE = 16000
MAX_SAMPLES = 330 * SAMPLE_RATE


def decode(source):
    resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    chunks = []
    count = 0
    with av.open(io.BytesIO(source), format="mov") as container:
        if not container.streams.audio:
            raise ValueError("Missing audio stream")
        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame):
                count += converted.samples
                if count > MAX_SAMPLES:
                    raise ValueError("Recording exceeds its duration limit")
                chunks.append(converted.to_ndarray().ravel())
        for converted in resampler.resample(None):
            count += converted.samples
            if count > MAX_SAMPLES:
                raise ValueError("Recording exceeds its duration limit")
            chunks.append(converted.to_ndarray().ravel())
    if not chunks:
        raise ValueError("Empty recording")
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def main():
    source = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(source) > MAX_BYTES:
        return 2
    try:
        samples = decode(source)
    except (ValueError, av.error.FFmpegError):
        print("Unsupported or invalid M4A recording", file=sys.stderr)
        return 2
    onnxruntime.disable_telemetry_events()
    model = WhisperModel(
        str(Path(sys.argv[1]).resolve(strict=True)), device="cpu", compute_type="int8",
        cpu_threads=min(os.cpu_count() or 1, 8), num_workers=1, local_files_only=True,
    )
    segments, _ = model.transcribe(
        samples, language="zh", task="transcribe", beam_size=5, vad_filter=True,
        condition_on_previous_text=False,
        initial_prompt="以下是普通话录音，请使用简体中文转写，保留英文术语。",
    )
    text = "".join(segment.text for segment in segments).strip()
    sys.stdout.buffer.write(OpenCC("t2s.json").convert(text).encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
