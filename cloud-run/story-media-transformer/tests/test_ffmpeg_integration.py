import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from transformer.core import (
    build_image_command,
    build_video_command,
    probe_media,
    run_command,
    validate_output_probe,
)


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "ffmpeg and ffprobe are required",
)
class FfmpegIntegrationTest(unittest.TestCase):
    def test_landscape_image_is_padded_to_story_canvas(self):
        with tempfile.TemporaryDirectory() as temp:
            input_path = Path(temp) / "input.jpg"
            output_path = Path(temp) / "output.jpg"
            run_command(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=size=1600x900:rate=1",
                    "-frames:v",
                    "1",
                    str(input_path),
                ]
            )
            run_command(
                build_image_command(input_path, output_path, "000000")
            )
            details = validate_output_probe(
                probe_media(output_path),
                "image",
            )
            self.assertEqual(details["width"], 1080)
            self.assertEqual(details["height"], 1920)

    def test_landscape_video_is_padded_and_normalized(self):
        with tempfile.TemporaryDirectory() as temp:
            input_path = Path(temp) / "input.mp4"
            output_path = Path(temp) / "output.mp4"
            run_command(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=size=1280x720:rate=30",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=1000:sample_rate=48000",
                    "-t",
                    "1",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    str(input_path),
                ]
            )
            run_command(
                build_video_command(input_path, output_path, "000000")
            )
            details = validate_output_probe(
                probe_media(output_path),
                "video",
            )
            self.assertEqual(details["width"], 1080)
            self.assertEqual(details["height"], 1920)
            self.assertEqual(details["video_codec"], "h264")
            self.assertEqual(details["audio_codec"], "aac")


if __name__ == "__main__":
    unittest.main()
