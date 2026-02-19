# Image Generation

Uses [mflux](https://github.com/filipstrand/mflux) with the [Z-Image Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) model (no HuggingFace login required).

## Generate an image

```bash
mflux-generate-z-image-turbo \
  --prompt "A banana wearing sunglasses" \
  --width 512 --height 512 \
  --steps 4 -q 8 \
  --output output.png
```

## Transparent backgrounds

Pipe through [rembg](https://github.com/danielgatis/rembg) to remove the background:

```bash
rembg i output.png output-transparent.png
```

## Performance (M4 Pro, 48GB)

| Resolution | Time |
|-----------|------|
| 256x256 | ~25s |
| 512x512 | ~30s |
| 1024x1024 | ~2 min |

Background removal adds ~6s.
