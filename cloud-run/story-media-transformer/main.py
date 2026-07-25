"""Cloud Run Job entrypoint for Instagram media conversion."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import google.auth
from google.api_core.exceptions import NotFound
from google.auth.transport.requests import Request
from google.cloud import storage
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

from transformer.core import (
    TransformError,
    build_image_command,
    build_video_copy_command,
    build_video_command,
    can_copy_without_transcoding,
    choose_output_frame_rate,
    normalize_background_color,
    normalize_media_target,
    probe_media,
    run_command,
    validate_input_mime_type,
    validate_output_probe,
    validate_source_revision,
    validate_video_probe,
)


logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
LOGGER = logging.getLogger(__name__)
MAX_INPUT_BYTES = 1024 * 1024 * 1024


def required_env(name: str) -> str:
    value = str(os.getenv(name, "")).strip()
    if not value:
        raise TransformError(f"Required environment variable is missing: {name}")
    return value


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def write_manifest(
    bucket: storage.Bucket,
    object_name: str,
    payload: dict[str, Any],
) -> None:
    bucket.blob(object_name).upload_from_string(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        content_type="application/json",
        if_generation_match=0 if payload.get("status") == "processing" else None,
    )


def replace_manifest(
    bucket: storage.Bucket,
    object_name: str,
    payload: dict[str, Any],
) -> None:
    bucket.blob(object_name).upload_from_string(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        content_type="application/json",
    )


def calculate_md5(path: Path) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_drive_file(
    file_id: str,
    destination: Path,
    expected_modified_time: str,
    expected_size: int,
    expected_md5: str,
) -> dict[str, Any]:
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/drive.readonly"]
    )
    drive = build(
        "drive",
        "v3",
        credentials=credentials,
        cache_discovery=False,
    )
    metadata = (
        drive.files()
        .get(
            fileId=file_id,
            supportsAllDrives=True,
            fields=(
                "id,name,mimeType,size,modifiedTime,"
                "md5Checksum,capabilities(canDownload)"
            ),
        )
        .execute()
    )
    if metadata.get("capabilities", {}).get("canDownload") is False:
        raise TransformError("The Drive file cannot be downloaded")
    actual_size = int(metadata.get("size") or 0)
    actual_modified_time = str(metadata.get("modifiedTime") or "")
    actual_md5 = str(metadata.get("md5Checksum") or "").lower()
    if actual_size <= 0 or actual_size > MAX_INPUT_BYTES:
        raise TransformError(
            f"Drive input size must be between 1 and {MAX_INPUT_BYTES} bytes: "
            f"{actual_size}"
        )
    validate_source_revision(
        actual_size,
        actual_modified_time,
        actual_md5,
        expected_size,
        expected_modified_time,
        expected_md5,
    )

    request = drive.files().get_media(
        fileId=file_id,
        supportsAllDrives=True,
    )
    with destination.open("wb") as output:
        downloader = MediaIoBaseDownload(output, request, chunksize=8 * 1024 * 1024)
        done = False
        while not done:
            status, done = downloader.next_chunk(num_retries=3)
            if status:
                LOGGER.info(
                    "Drive download progress: %.1f%%",
                    status.progress() * 100,
                )
    if destination.stat().st_size != actual_size:
        raise TransformError("Downloaded Drive file size does not match metadata")
    if actual_md5 and calculate_md5(destination) != actual_md5:
        raise TransformError(
            "Downloaded Drive file checksum does not match metadata"
        )
    return metadata


def generate_signed_url(
    blob: storage.Blob,
    service_account_email: str,
    hours: int,
) -> tuple[str, datetime]:
    credentials, _ = google.auth.default()
    credentials.refresh(Request())
    expires_at = utc_now() + timedelta(hours=hours)
    url = blob.generate_signed_url(
        version="v4",
        expiration=expires_at,
        method="GET",
        service_account_email=service_account_email,
        access_token=credentials.token,
    )
    return url, expires_at


def load_ready_manifest(
    bucket: storage.Bucket,
    result_object: str,
) -> dict[str, Any] | None:
    blob = bucket.blob(result_object)
    try:
        data = json.loads(blob.download_as_text())
    except NotFound:
        return None
    if data.get("status") != "ready":
        return None
    output_object = str(data.get("output_object") or "")
    if not output_object or not bucket.blob(output_object).exists():
        return None
    return data


def refresh_ready_manifest_url(
    bucket: storage.Bucket,
    result_object: str,
    manifest: dict[str, Any],
    service_account_email: str,
    signed_url_hours: int,
) -> None:
    output_blob = bucket.blob(manifest["output_object"])
    url, expires_at = generate_signed_url(
        output_blob,
        service_account_email,
        signed_url_hours,
    )
    manifest["output_url"] = url
    manifest["output_url_expires_at"] = isoformat_utc(expires_at)
    manifest["updated_at"] = isoformat_utc(utc_now())
    replace_manifest(bucket, result_object, manifest)


def run() -> None:
    job_id = str(
        os.getenv("MEDIA_JOB_ID") or os.getenv("STORY_JOB_ID") or ""
    ).strip()
    if not job_id:
        raise TransformError(
            "Required environment variable is missing: MEDIA_JOB_ID"
        )
    media_target = normalize_media_target(
        os.getenv("MEDIA_TARGET", "stories")
    )
    drive_file_id = required_env("DRIVE_FILE_ID")
    expected_modified_time = required_env("EXPECTED_SOURCE_MODIFIED_TIME")
    expected_size = int(required_env("EXPECTED_SOURCE_SIZE"))
    if expected_size <= 0 or expected_size > MAX_INPUT_BYTES:
        raise TransformError(
            f"EXPECTED_SOURCE_SIZE must be between 1 and {MAX_INPUT_BYTES}"
        )
    expected_md5 = str(os.getenv("EXPECTED_SOURCE_MD5", "")).strip().lower()
    media_kind = required_env("MEDIA_KIND")
    if media_kind not in {"image", "video"}:
        raise TransformError("MEDIA_KIND must be image or video")

    background_color = normalize_background_color(
        os.getenv("BACKGROUND_COLOR", "000000")
    )
    output_bucket_name = required_env("OUTPUT_BUCKET")
    output_prefix = required_env("OUTPUT_PREFIX").rstrip("/")
    result_object = required_env("RESULT_OBJECT")
    service_account_email = required_env("SERVICE_ACCOUNT_EMAIL")
    signed_url_hours = int(os.getenv("SIGNED_URL_HOURS", "30"))
    if signed_url_hours < 1 or signed_url_hours > 168:
        raise TransformError("SIGNED_URL_HOURS must be between 1 and 168")

    storage_client = storage.Client()
    bucket = storage_client.bucket(output_bucket_name)

    existing = load_ready_manifest(bucket, result_object)
    if existing and existing.get("job_id") == job_id:
        LOGGER.info("Reusing ready output for job %s", job_id)
        refresh_ready_manifest_url(
            bucket,
            result_object,
            existing,
            service_account_email,
            signed_url_hours,
        )
        return

    processing_manifest = {
        "status": "processing",
        "job_id": job_id,
        "media_kind": media_kind,
        "media_target": media_target,
        "started_at": isoformat_utc(utc_now()),
    }
    try:
        write_manifest(bucket, result_object, processing_manifest)
    except Exception:
        # A retry may see the processing manifest created by an earlier attempt.
        replace_manifest(bucket, result_object, processing_manifest)

    suffix = ".mp4" if media_kind == "video" else ".jpg"
    content_type = "video/mp4" if media_kind == "video" else "image/jpeg"
    output_object = f"{output_prefix}/{job_id}{suffix}"

    try:
        with tempfile.TemporaryDirectory(
            prefix=f"{media_target}-transform-"
        ) as tmp:
            tmp_path = Path(tmp)
            input_path = tmp_path / "input"
            output_path = tmp_path / f"output{suffix}"

            metadata = download_drive_file(
                drive_file_id,
                input_path,
                expected_modified_time,
                expected_size,
                expected_md5,
            )
            mime_type = str(metadata.get("mimeType") or "")
            validate_input_mime_type(media_kind, mime_type)

            input_probe = probe_media(input_path)
            copied_without_transcoding = can_copy_without_transcoding(
                input_probe,
                media_kind,
                mime_type,
                media_target,
            )
            if media_kind == "video":
                validate_video_probe(input_probe, media_target)
                command = build_video_command(
                    input_path,
                    output_path,
                    background_color,
                    choose_output_frame_rate(input_probe),
                    "4.2" if media_target == "reels" else "4.1",
                )
            else:
                command = build_image_command(
                    input_path,
                    output_path,
                    background_color,
                )

            if copied_without_transcoding:
                LOGGER.info(
                    "Input already meets %s output requirements: %s",
                    media_target,
                    job_id,
                )
                if media_kind == "video":
                    run_command(
                        build_video_copy_command(input_path, output_path)
                    )
                else:
                    shutil.copyfile(input_path, output_path)
            else:
                LOGGER.info("Starting FFmpeg conversion for job %s", job_id)
                run_command(command)
            if output_path.stat().st_size > MAX_INPUT_BYTES:
                raise TransformError(
                    "Transformed output exceeds the Instagram 1 GiB limit"
                )
            output_probe = probe_media(output_path)
            output_details = validate_output_probe(
                output_probe,
                media_kind,
                media_target,
            )

            output_blob = bucket.blob(output_object)
            output_blob.upload_from_filename(
                str(output_path),
                content_type=content_type,
            )
            output_url, expires_at = generate_signed_url(
                output_blob,
                service_account_email,
                signed_url_hours,
            )

            manifest = {
                "status": "ready",
                "job_id": job_id,
                "media_kind": media_kind,
                "media_target": media_target,
                "source_file_id": drive_file_id,
                "source_modified_time": metadata.get("modifiedTime", ""),
                "source_size": int(metadata.get("size") or 0),
                "source_md5_checksum": str(
                    metadata.get("md5Checksum") or ""
                ).lower(),
                "output_object": output_object,
                "output_url": output_url,
                "output_url_expires_at": isoformat_utc(expires_at),
                "content_type": content_type,
                "background_color": background_color,
                "transformed": not copied_without_transcoding,
                "completed_at": isoformat_utc(utc_now()),
                **output_details,
            }
            replace_manifest(bucket, result_object, manifest)
            LOGGER.info(
                "%s transformation completed: %s",
                media_target,
                job_id,
            )
    except Exception as error:
        LOGGER.exception(
            "%s transformation failed: %s",
            media_target,
            job_id,
        )
        try:
            existing = load_ready_manifest(bucket, result_object)
        except Exception:
            LOGGER.exception(
                "Could not check for a concurrently completed manifest"
            )
            existing = None
        if existing and existing.get("job_id") == job_id:
            LOGGER.warning(
                "Keeping a concurrently completed ready manifest for job %s",
                job_id,
            )
            return
        failure_manifest = {
            "status": "error",
            "job_id": job_id,
            "media_kind": media_kind,
            "media_target": media_target,
            "error_type": type(error).__name__,
            "error": str(error)[:1000],
            "failed_at": isoformat_utc(utc_now()),
        }
        try:
            replace_manifest(bucket, result_object, failure_manifest)
        except Exception:
            LOGGER.exception("Could not write failure manifest")
        raise


if __name__ == "__main__":
    run()
