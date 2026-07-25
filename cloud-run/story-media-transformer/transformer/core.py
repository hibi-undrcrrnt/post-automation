"""Pure validation and FFmpeg command construction."""

from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


OUTPUT_WIDTH = 1080
OUTPUT_HEIGHT = 1920
STORY_MAX_VIDEO_SECONDS = 60.0
REEL_MIN_VIDEO_SECONDS = 3.0
REEL_MAX_VIDEO_SECONDS = 15.0 * 60.0
DEFAULT_OUTPUT_FRAME_RATE = "30"
SUPPORTED_MEDIA_TARGETS = {"stories", "reels"}
SUPPORTED_IMAGE_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
}
SUPPORTED_VIDEO_MIME_TYPES = {
    "video/mp4",
    "video/quicktime",
}


class TransformError(RuntimeError):
    """A permanent input or transformation error."""


def parse_rfc3339_utc(value: str, field_name: str) -> datetime:
    raw_value = str(value or "").strip()
    try:
        parsed = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
    except ValueError as error:
        raise TransformError(
            f"{field_name} is not a valid RFC 3339 timestamp: {raw_value}"
        ) from error
    if parsed.tzinfo is None:
        raise TransformError(
            f"{field_name} must include a timezone: {raw_value}"
        )
    return parsed.astimezone(timezone.utc)


def validate_source_revision(
    actual_size: int,
    actual_modified_time: str,
    actual_md5: str,
    expected_size: int,
    expected_modified_time: str,
    expected_md5: str,
) -> None:
    if actual_size != expected_size:
        raise TransformError(
            "Drive input size changed after the transform was scheduled "
            f"(expected={expected_size}, actual={actual_size})"
        )

    actual_time = parse_rfc3339_utc(
        actual_modified_time,
        "Drive input modifiedTime",
    )
    expected_time = parse_rfc3339_utc(
        expected_modified_time,
        "EXPECTED_SOURCE_MODIFIED_TIME",
    )
    if actual_time != expected_time:
        raise TransformError(
            "Drive input modifiedTime changed after the transform was "
            "scheduled "
            f"(expected={expected_modified_time}, "
            f"actual={actual_modified_time})"
        )

    normalized_actual_md5 = str(actual_md5 or "").strip().lower()
    normalized_expected_md5 = str(expected_md5 or "").strip().lower()
    if (
        normalized_expected_md5
        and normalized_actual_md5 != normalized_expected_md5
    ):
        raise TransformError(
            "Drive input checksum changed after the transform was scheduled"
        )


def normalize_background_color(value: str) -> str:
    color = str(value or "").strip().removeprefix("#")
    if not re.fullmatch(r"[0-9a-fA-F]{6}", color):
        raise TransformError(
            "BACKGROUND_COLOR must be a six-digit hexadecimal color"
        )
    return color.lower()


def validate_input_mime_type(media_kind: str, mime_type: str) -> None:
    supported = (
        SUPPORTED_VIDEO_MIME_TYPES
        if media_kind == "video"
        else SUPPORTED_IMAGE_MIME_TYPES
    )
    if mime_type not in supported:
        raise TransformError(
            f"Unsupported {media_kind} MIME type: {mime_type or 'unknown'}"
        )


def run_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as error:
        details = str(error.stderr or error.stdout or "").strip()
        if len(details) > 2000:
            details = details[-2000:]
        raise TransformError(
            f"{Path(command[0]).name} failed"
            + (f": {details}" if details else "")
        ) from error


def probe_media(path: Path) -> dict[str, Any]:
    result = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ]
    )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise TransformError("ffprobe returned invalid JSON") from error


def first_video_stream(probe: dict[str, Any]) -> dict[str, Any]:
    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "video":
            return stream
    raise TransformError("Input has no video/image stream")


def first_audio_stream(probe: dict[str, Any]) -> dict[str, Any] | None:
    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "audio":
            return stream
    return None


def stream_rotation(stream: dict[str, Any]) -> int:
    raw_values = [stream.get("tags", {}).get("rotate")]
    raw_values.extend(
        side_data.get("rotation")
        for side_data in stream.get("side_data_list", [])
    )
    for raw_value in raw_values:
        if raw_value in (None, ""):
            continue
        try:
            return int(round(float(raw_value))) % 360
        except (TypeError, ValueError):
            continue
    return 0


def parse_duration_seconds(probe: dict[str, Any]) -> float | None:
    raw_value = probe.get("format", {}).get("duration")
    if raw_value in (None, ""):
        raw_value = first_video_stream(probe).get("duration")
    if raw_value in (None, ""):
        return None
    try:
        return float(raw_value)
    except (TypeError, ValueError) as error:
        raise TransformError(f"Invalid media duration: {raw_value}") from error


def normalize_media_target(media_target: str) -> str:
    normalized = str(media_target or "").strip().lower()
    if normalized not in SUPPORTED_MEDIA_TARGETS:
        raise TransformError(
            "MEDIA_TARGET must be stories or reels: "
            f"{media_target or 'empty'}"
        )
    return normalized


def parse_frame_rate(value: Any) -> float | None:
    raw_value = str(value or "").strip()
    if not raw_value or raw_value == "0/0":
        return None
    try:
        if "/" in raw_value:
            numerator, denominator = raw_value.split("/", 1)
            denominator_value = float(denominator)
            if denominator_value == 0:
                return None
            return float(numerator) / denominator_value
        return float(raw_value)
    except (TypeError, ValueError):
        return None


def choose_output_frame_rate(probe: dict[str, Any]) -> str:
    stream = first_video_stream(probe)
    average = parse_frame_rate(stream.get("avg_frame_rate"))
    nominal = parse_frame_rate(stream.get("r_frame_rate"))
    if (
        average is not None
        and nominal is not None
        and 23.0 <= average <= 60.0
        and abs(average - nominal) <= 0.01
    ):
        return str(stream.get("avg_frame_rate"))
    return DEFAULT_OUTPUT_FRAME_RATE


def validate_video_probe(
    probe: dict[str, Any],
    media_target: str = "stories",
) -> None:
    target = normalize_media_target(media_target)
    duration = parse_duration_seconds(probe)
    if duration is None:
        raise TransformError("Video duration could not be determined")
    minimum = 0.0 if target == "stories" else REEL_MIN_VIDEO_SECONDS
    maximum = (
        STORY_MAX_VIDEO_SECONDS
        if target == "stories"
        else REEL_MAX_VIDEO_SECONDS
    )
    if duration <= minimum or duration > maximum:
        label = "Instagram Stories" if target == "stories" else "Instagram Reels"
        raise TransformError(
            f"{label} video duration must be greater than "
            f"{minimum:.0f} seconds and at most {maximum:.0f} seconds: "
            f"{duration:.3f}"
        )


def can_copy_without_transcoding(
    probe: dict[str, Any],
    media_kind: str,
    mime_type: str,
    media_target: str = "stories",
) -> bool:
    target = normalize_media_target(media_target)
    stream = first_video_stream(probe)
    if (
        int(stream.get("width") or 0) != OUTPUT_WIDTH
        or int(stream.get("height") or 0) != OUTPUT_HEIGHT
        or stream_rotation(stream) != 0
    ):
        return False

    if media_kind == "image":
        return (
            mime_type == "image/jpeg"
            and stream.get("codec_name") in {"mjpeg", "jpeg"}
        )

    if media_kind == "video":
        validate_video_probe(probe, target)
        # Reels are always re-encoded so that MOV metadata/data tracks, audio
        # bitrate/channel layout and variable frame rate cannot leak through.
        if target == "reels":
            return False
        audio = first_audio_stream(probe)
        return (
            mime_type == "video/mp4"
            and stream.get("codec_name") == "h264"
            and stream.get("pix_fmt") == "yuv420p"
            and (audio is None or audio.get("codec_name") == "aac")
        )

    return False


def video_filter(background_color: str) -> str:
    color = normalize_background_color(background_color)
    return (
        "scale="
        f"{OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:"
        "force_original_aspect_ratio=decrease:"
        "force_divisible_by=2,"
        "pad="
        f"{OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:"
        "(ow-iw)/2:(oh-ih)/2:"
        f"color=0x{color},"
        "setsar=1"
    )


def build_image_command(
    input_path: Path,
    output_path: Path,
    background_color: str,
) -> list[str]:
    return [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-vf",
        video_filter(background_color),
        "-frames:v",
        "1",
        "-q:v",
        "2",
        str(output_path),
    ]


def build_video_command(
    input_path: Path,
    output_path: Path,
    background_color: str,
    output_frame_rate: str = DEFAULT_OUTPUT_FRAME_RATE,
    output_level: str = "4.1",
) -> list[str]:
    return [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-dn",
        "-vf",
        video_filter(background_color),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-profile:v",
        "high",
        "-level",
        str(output_level),
        "-pix_fmt",
        "yuv420p",
        "-fps_mode",
        "cfr",
        "-r",
        str(output_frame_rate),
        "-maxrate",
        "10M",
        "-bufsize",
        "20M",
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-b:a",
        "128k",
        "-max_muxing_queue_size",
        "4096",
        str(output_path),
    ]


def build_video_copy_command(
    input_path: Path,
    output_path: Path,
) -> list[str]:
    return [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-dn",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(output_path),
    ]


def validate_output_probe(
    probe: dict[str, Any],
    media_kind: str,
    media_target: str = "stories",
) -> dict[str, Any]:
    target = normalize_media_target(media_target)
    stream = first_video_stream(probe)
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    if width != OUTPUT_WIDTH or height != OUTPUT_HEIGHT:
        raise TransformError(
            f"Output resolution is {width}x{height}; "
            f"expected {OUTPUT_WIDTH}x{OUTPUT_HEIGHT}"
        )

    details: dict[str, Any] = {
        "width": width,
        "height": height,
        "video_codec": str(stream.get("codec_name") or ""),
        "pixel_format": str(stream.get("pix_fmt") or ""),
    }

    if media_kind == "video":
        validate_video_probe(probe, target)
        unexpected_stream_types = sorted(
            {
                str(stream.get("codec_type") or "unknown")
                for stream in probe.get("streams", [])
                if stream.get("codec_type") not in {"video", "audio"}
            }
        )
        if unexpected_stream_types:
            raise TransformError(
                "Output contains unsupported stream types: "
                + ", ".join(unexpected_stream_types)
            )
        if details["video_codec"] != "h264":
            raise TransformError(
                f"Output video codec is {details['video_codec']}; expected h264"
            )
        if details["pixel_format"] != "yuv420p":
            raise TransformError(
                "Output pixel format is "
                f"{details['pixel_format']}; expected yuv420p"
            )
        audio = first_audio_stream(probe)
        if audio and audio.get("codec_name") != "aac":
            raise TransformError(
                f"Output audio codec is {audio.get('codec_name')}; expected aac"
            )
        details["audio_codec"] = (
            str(audio.get("codec_name") or "") if audio else ""
        )
        if audio:
            sample_rate = int(audio.get("sample_rate") or 0)
            channels = int(audio.get("channels") or 0)
            if target == "reels" and sample_rate != 48000:
                raise TransformError(
                    f"Output audio sample rate is {sample_rate}; expected 48000"
                )
            if target == "reels" and (channels < 1 or channels > 2):
                raise TransformError(
                    f"Output audio channels is {channels}; expected 1 or 2"
                )
            if sample_rate:
                details["audio_sample_rate"] = sample_rate
            if channels:
                details["audio_channels"] = channels
        frame_rate = parse_frame_rate(stream.get("avg_frame_rate"))
        nominal_frame_rate = parse_frame_rate(stream.get("r_frame_rate"))
        if target == "reels" and (
            frame_rate is None
            or nominal_frame_rate is None
            or frame_rate < 23.0
            or frame_rate > 60.0
            or abs(frame_rate - nominal_frame_rate) > 0.01
        ):
            raise TransformError(
                "Output video frame rate must be CFR between 23 and 60 fps: "
                f"avg={stream.get('avg_frame_rate') or 'unknown'}, "
                f"nominal={stream.get('r_frame_rate') or 'unknown'}"
            )
        details["frame_rate"] = frame_rate
        details["duration_seconds"] = parse_duration_seconds(probe)

    return details
