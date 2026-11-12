#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../../.." && pwd)
SDK_PATH=$(xcrun --sdk macosx --show-sdk-path)
ARCH=$(uname -m)
OUTPUT_DIR="$ROOT_DIR/build/computer-use"
OUTPUT="$OUTPUT_DIR/open-computer-use-helper"
SOURCE="$SCRIPT_DIR/OpenComputerUseHelper.swift"

mkdir -p "$OUTPUT_DIR"

xcrun --sdk macosx swiftc \
  -sdk "$SDK_PATH" \
  -target "$ARCH-apple-macosx14.0" \
  -swift-version 5 \
  -O \
  -whole-module-optimization \
  -framework AppKit \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -framework CoreVideo \
  -framework Foundation \
  -framework ScreenCaptureKit \
  "$SOURCE" \
  -o "$OUTPUT"
