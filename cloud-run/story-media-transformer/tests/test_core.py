import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from transformer.core import (
    TransformError,
    build_image_command,
    build_video_copy_command,
    build_video_command,
    can_copy_without_transcoding,
    normalize_background_color,
    validate_output_probe,
    validate_source_revision,
    validate_video_probe,
    video_filter,
)


class CoreTest(unittest.TestCase):
    def test_normalize_background_color(self):
        self.assertEqual(normalize_background_color("#A0b1C2"), "a0b1c2")
        with self.assertRaises(TransformError):
            normalize_background_color("black")

    def test_source_revision_compares_rfc3339_instants(self):
        validate_source_revision(
            123,
            "2026-07-23T02:38:26.676000Z",
            "ABC123",
            123,
            "2026-07-23T11:38:26.676+09:00",
            "abc123",
        )

    def test_source_revision_rejects_a_real_timestamp_change(self):
        with self.assertRaisesRegex(
            TransformError,
            r"expected=.*actual=",
        ):
            validate_source_revision(
                123,
                "2026-07-23T02:38:26.677Z",
                "",
                123,
                "2026-07-23T02:38:26.676Z",
                "",
            )

    def test_filter_preserves_aspect_ratio_and_pads(self):
        self.assertEqual(
            video_filter("000000"),
            "scale=1080:1920:"
            "force_original_aspect_ratio=decrease:"
            "force_divisible_by=2,"
            "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:"
            "color=0x000000,setsar=1",
        )

    def test_image_command_outputs_one_jpeg_frame(self):
        command = build_image_command(
            Path("/tmp/input"),
            Path("/tmp/output.jpg"),
            "112233",
        )
        self.assertIn("-frames:v", command)
        self.assertIn("1", command)
        self.assertEqual(command[-1], "/tmp/output.jpg")

    def test_video_command_normalizes_instagram_codecs(self):
        command = build_video_command(
            Path("/tmp/input"),
            Path("/tmp/output.mp4"),
            "000000",
        )
        self.assertIn("libx264", command)
        self.assertIn("yuv420p", command)
        self.assertIn("aac", command)
        self.assertIn("+faststart", command)

    def test_video_copy_command_remuxes_without_quality_loss(self):
        command = build_video_copy_command(
            Path("/tmp/input.mp4"),
            Path("/tmp/output.mp4"),
        )
        self.assertIn("copy", command)
        self.assertIn("+faststart", command)

    def test_rejects_video_over_sixty_seconds(self):
        with self.assertRaisesRegex(TransformError, "at most 60 seconds"):
            validate_video_probe(
                {
                    "format": {"duration": "60.001"},
                    "streams": [
                        {
                            "codec_type": "video",
                            "width": 1280,
                            "height": 720,
                        }
                    ],
                }
            )

    def test_validates_normalized_video_output(self):
        details = validate_output_probe(
            {
                "format": {"duration": "30.0"},
                "streams": [
                    {
                        "codec_type": "video",
                        "width": 1080,
                        "height": 1920,
                        "codec_name": "h264",
                        "pix_fmt": "yuv420p",
                    },
                    {
                        "codec_type": "audio",
                        "codec_name": "aac",
                    },
                ],
            },
            "video",
        )
        self.assertEqual(details["width"], 1080)
        self.assertEqual(details["height"], 1920)
        self.assertEqual(details["audio_codec"], "aac")

    def test_exact_story_mp4_can_be_copied_without_transcoding(self):
        probe = {
            "format": {"duration": "30.0"},
            "streams": [
                {
                    "codec_type": "video",
                    "width": 1080,
                    "height": 1920,
                    "codec_name": "h264",
                    "pix_fmt": "yuv420p",
                },
                {
                    "codec_type": "audio",
                    "codec_name": "aac",
                },
            ],
        }
        self.assertTrue(
            can_copy_without_transcoding(probe, "video", "video/mp4")
        )
        probe["streams"][0]["tags"] = {"rotate": "90"}
        self.assertFalse(
            can_copy_without_transcoding(probe, "video", "video/mp4")
        )


if __name__ == "__main__":
    unittest.main()
