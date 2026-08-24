#!/usr/bin/env bash
#
# Build the intro film from the supplied source clip and logo.
#
# Reproducible on purpose: the intro is a build artefact, not a binary somebody
# hand-edited and dropped in. Re-run it after changing the source, the logo or
# any of the copy below and the deliverables regenerate identically.
#
#   ./scripts/build-intro.sh
#
# Inputs   assets/intro-source.mp4, assets/urban-visions-logo-reverse.png
# Outputs  public/media/intro.mp4, intro.webm, intro-poster.jpg, intro-still.jpg
#
# Requires ffmpeg with libx264, drawtext (freetype) and the DejaVu fonts.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/assets/intro-source.mp4"
# The reverse variant, not the original. The supplied mark is chrome-on-white:
# its lower half is near-black and simply vanishes on a dark background. The
# reverse lifts the neutral chrome and leaves the crimson glow alone — lifting
# that too turns it pink, which is a different brand. Regenerate it with
# scripts/build-logo.py.
LOGO="$ROOT/assets/urban-visions-logo-reverse.png"
OUT_DIR="$ROOT/public/media"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

MONO="/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
SANS="/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf"
[ -f "$SANS" ] || SANS="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

mkdir -p "$OUT_DIR"

W=1280
H=720
FPS=30

# ---------------------------------------------------------------------------
# 1. Scanline and grid plate
# ---------------------------------------------------------------------------
# Generated at FULL frame size, not as a small tile that is scaled up.
#
# The first version made a 4x4 tile and scaled it to 1280x720, which is a 320x
# magnification — the result was four enormous horizontal bands across the logo
# card, not scanlines. Obvious in hindsight, invisible until you look at a
# frame. Generating at output resolution makes the line spacing exact.
ffmpeg -v error -y -f lavfi -i "color=c=black:s=${W}x${H}" -vf \
  "format=rgba,geq=r='0':g='255':b='255':a='if(lt(mod(Y,3),1),22,0)'" \
  -frames:v 1 "$WORK/scanline.png"

# ---------------------------------------------------------------------------
# 2. Logo plate — trimmed, scaled, with a soft glow so chrome reads on black
# ---------------------------------------------------------------------------
ffmpeg -v error -y -i "$LOGO" -filter_complex \
  "[0:v]format=rgba,scale=520:-1[lg];\
   [lg]split=2[a][b];\
   [b]boxblur=18:2,colorchannelmixer=aa=0.4[glow];\
   [glow][a]overlay=0:0:format=auto[out]" \
  -map "[out]" "$WORK/logo-plate.png"

# ---------------------------------------------------------------------------
# 3. Typographic beats over the graded source
# ---------------------------------------------------------------------------
# Each beat is drawn twice: a cyan copy offset by two pixels, then the white
# copy on top. That is a chromatic split done with two draws — it reads as
# lens fringing on a HUD and costs nothing to render.
#
# `alpha` on every drawtext is a dissolve, not a cut. Text that pops on and off
# looks like a bug; text that resolves looks deliberate.

beat() { # start end text size y colour
  local s=$1 e=$2 t=$3 sz=$4 y=$5 c=$6
  local fade="if(lt(t,$s),0,if(lt(t,$s+0.5),(t-$s)/0.5,if(lt(t,$e-0.5),1,if(lt(t,$e),($e-t)/0.5,0))))"
  echo "drawtext=fontfile=$MONO:text='$t':fontsize=$sz:fontcolor=${c}@1:x=(w-text_w)/2:y=$y:alpha='$fade'"
}

CYAN="0x5ee7f5"
WHITE="0xffffff"

FILTER="[0:v]fps=$FPS,format=rgba"

# Grade: deepen the blacks, hold the cyan, add a touch of contrast.
FILTER="$FILTER,eq=contrast=1.12:saturation=1.15:gamma=0.95"

# Vignette and grain — the two cheapest cues that something is a screen.
FILTER="$FILTER,vignette=PI/4.5"
# Grain is deliberately light. It is the single most expensive thing here in
# bitrate terms — film grain is close to incompressible, and at alls=6 this
# clip encoded to 5.7 MB, which is a slow first paint on a phone for something
# the viewer did not ask for.
FILTER="$FILTER,noise=alls=3:allf=t+u"

FILTER="$FILTER[graded];"

# Scanlines tiled over the whole frame.
FILTER="$FILTER[1:v]null[scan];"
FILTER="$FILTER[graded][scan]overlay=0:0[scanned];"

# --- beat 1: the house -----------------------------------------------------
B1="URBAN VISIONS ENTERPRISES"
FILTER="$FILTER[scanned]$(beat 0.6 3.0 "$B1" 30 "h*0.14+3" $CYAN)[b1a];"
FILTER="$FILTER[b1a]$(beat 0.6 3.0 "$B1" 30 "h*0.14" $WHITE)[b1];"

# --- beat 2: what it is ----------------------------------------------------
B2="MULTIMEDIA PRODUCT ARBITRAGE"
FILTER="$FILTER[b1]$(beat 3.0 5.4 "$B2" 30 "h*0.14+3" $CYAN)[b2a];"
FILTER="$FILTER[b2a]$(beat 3.0 5.4 "$B2" 30 "h*0.14" $WHITE)[b2];"

# --- beat 3: the mandate ---------------------------------------------------
B3="ZERO-LOSS MANDATE"
FILTER="$FILTER[b2]$(beat 5.4 7.9 "$B3" 30 "h*0.14+3" $CYAN)[b3a];"
FILTER="$FILTER[b3a]$(beat 5.4 7.9 "$B3" 30 "h*0.14" $WHITE)[b3];"

# The delta-pi line sits under it, smaller, in the same mono face — the actual
# rule the product enforces, stated as the rule.
DP="d(pi) > 0.00  ENFORCED SERVER-SIDE"
FILTER="$FILTER[b3]$(beat 5.7 7.9 "$DP" 19 "h*0.14+44" $CYAN)[b3d];"

# --- running readout, bottom-left ------------------------------------------
# A HUD needs something that looks like it is counting. This is the one piece
# of on-screen text that changes per frame.
FILTER="$FILTER[b3d]drawtext=fontfile=$MONO:text='SYS %{eif\\:trunc(t*1000)\\:d\\:6}':fontsize=16:fontcolor=${CYAN}@0.75:x=42:y=h-52:alpha='if(lt(t,1.0),0,if(lt(t,1.6),(t-1.0)/0.6,1))'[hud];"

# --- open from black -------------------------------------------------------
FILTER="$FILTER[hud]fade=t=in:st=0:d=0.6,format=yuv420p[va]"

ffmpeg -v error -y -i "$SRC" -i "$WORK/scanline.png" \
  -filter_complex "$FILTER" \
  -map "[va]" -map 0:a? \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  "$WORK/part-a.mp4"

# ---------------------------------------------------------------------------
# 4. Logo card
# ---------------------------------------------------------------------------
# Ends on the house mark rather than the product name: the film is the company
# introducing the product, so the company signs it.
CARD_SECS=3.6

ffmpeg -v error -y \
  -f lavfi -t $CARD_SECS -i "color=c=0x09090b:s=${W}x${H}:r=$FPS" \
  -i "$WORK/logo-plate.png" \
  -i "$WORK/scanline.png" \
  -filter_complex "\
   [2:v]null[scan];\
   [0:v]format=rgba[bg];\
   [bg][scan]overlay=0:0[bgs];\
   [1:v]format=rgba,scale=-1:400[lg];\
   [bgs][lg]overlay=(W-w)/2:(H-h)/2-30:format=auto:\
     enable='gte(t,0.2)'[withlogo];\
   [withlogo]drawtext=fontfile=$MONO:text='V12 APEX ATLAS':fontsize=26:fontcolor=${WHITE}@1:\
     x=(w-text_w)/2:y=h*0.80:alpha='if(lt(t,1.4),0,if(lt(t,2.0),(t-1.4)/0.6,1))'[t1];\
   [t1]drawtext=fontfile=$MONO:text='AGENTIC OPERATIONS WORKSPACE':fontsize=17:fontcolor=${CYAN}@0.85:\
     x=(w-text_w)/2:y=h*0.80+38:alpha='if(lt(t,1.7),0,if(lt(t,2.3),(t-1.7)/0.6,1))'[t2];\
   [t2]fade=t=in:st=0.1:d=0.7:alpha=0,fade=t=out:st=$(echo "$CARD_SECS - 0.9" | bc):d=0.9,\
     vignette=PI/5,format=yuv420p[vb]" \
  -map "[vb]" -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
  "$WORK/part-b.mp4"

# ---------------------------------------------------------------------------
# 5. Dissolve the two together
# ---------------------------------------------------------------------------
# xfade rather than concat: the brief asked for dissolves, and a hard cut from
# a moving tunnel to a static card is exactly where one is most missed.
A_DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/part-a.mp4")
XF=0.9
OFFSET=$(echo "$A_DUR - $XF" | bc)

ffmpeg -v error -y -i "$WORK/part-a.mp4" -i "$WORK/part-b.mp4" -filter_complex "\
  [0:v][1:v]xfade=transition=fade:duration=$XF:offset=$OFFSET,format=yuv420p[v];\
  [0:a]afade=t=out:st=$(echo "$A_DUR - 1.6" | bc):d=1.6[a]" \
  -map "[v]" -map "[a]" \
  -c:v libx264 -preset veryslow -crf 26 -maxrate 2200k -bufsize 4400k \
  -profile:v main -level 4.0 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 96k -ac 2 \
  "$OUT_DIR/intro.mp4"

# ---------------------------------------------------------------------------
# 5b. VP9 / WebM fallback
# ---------------------------------------------------------------------------
# H.264 is not universal.
#
# Chromium builds compiled without proprietary codecs — several Linux
# distributions, and the Chromium that ships with Playwright — cannot decode it
# at all. The player's error path handles that by skipping to the launch page,
# which is correct but means those visitors never see the film. VP9 in WebM is
# royalty-free and present in every such build, so it is offered as a second
# source and the browser picks whichever it can actually play.
#
# Caught by screenshotting the intro in headless Chromium and finding the
# launch page instead.
ffmpeg -v error -y -i "$OUT_DIR/intro.mp4" \
  -c:v libvpx-vp9 -crf 36 -b:v 0 -row-mt 1 -deadline good -cpu-used 2 \
  -c:a libopus -b:a 96k \
  "$OUT_DIR/intro.webm"

# ---------------------------------------------------------------------------
# 6. Poster and a still for social preview
# ---------------------------------------------------------------------------
# The poster is what a browser shows before the video decodes, and what a phone
# on a slow connection may show instead of it. Taken from the title beat rather
# than frame zero, which is near-black.
ffmpeg -v error -y -ss 7.4 -i "$OUT_DIR/intro.mp4" -frames:v 1 -q:v 3 "$OUT_DIR/intro-poster.jpg"
ffmpeg -v error -y -ss 10.2 -i "$OUT_DIR/intro.mp4" -frames:v 1 -q:v 3 "$OUT_DIR/intro-still.jpg"

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT_DIR/intro.mp4")
SIZE=$(du -h "$OUT_DIR/intro.mp4" | cut -f1)
WEBM=$(du -h "$OUT_DIR/intro.webm" | cut -f1)
echo "[intro] built ${DUR}s — intro.mp4 ${SIZE}, intro.webm ${WEBM}"
