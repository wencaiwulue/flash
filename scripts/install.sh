#!/bin/sh
set -eu

REPOSITORY='https://github.com/wencaiwulue/flash'
BINARY_NAME='flash'
RELEASES_URL=${CLAUDE_CODE_DOWNLOAD_BASE_URL:-"$REPOSITORY/releases"}
RELEASES_URL=${RELEASES_URL%/}
VERSION=${VERSION:-}
INSTALL_DIR=${INSTALL_DIR:-}
work_dir=''
staging_file=''

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  status=$?
  cleanup_error=0
  trap - 0 HUP INT TERM
  if [ -n "$staging_file" ] && ! rm -f "$staging_file"; then
    printf 'Warning: unable to remove staging file: %s\n' "$staging_file" >&2
    cleanup_error=1
  fi
  if [ -n "$work_dir" ] && ! rm -rf "$work_dir"; then
    printf 'Warning: unable to remove temporary directory: %s\n' "$work_dir" >&2
    cleanup_error=1
  fi
  if [ "$status" -eq 0 ] && [ "$cleanup_error" -ne 0 ]; then
    status=1
  fi
  exit "$status"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

valid_version() {
  case "$1" in
    ''|*[!0-9v.]*) return 1 ;;
  esac
  printf '%s\n' "$1" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
}

main() {
  [ "$#" -eq 0 ] || fail 'Use VERSION and INSTALL_DIR environment variables instead of arguments.'
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  for command in curl uname tar mktemp grep awk cp chmod mv mkdir rm; do
    require_command "$command"
  done

  if command -v sha256sum >/dev/null 2>&1; then
    checksum_command='sha256sum'
  elif command -v shasum >/dev/null 2>&1; then
    checksum_command='shasum'
  else
    fail 'Required command not found: sha256sum or shasum'
  fi

  if [ -z "$INSTALL_DIR" ]; then
    [ -n "${HOME:-}" ] || fail 'Set INSTALL_DIR when HOME is unavailable.'
    INSTALL_DIR="$HOME/.local/bin"
  fi

  case "$(uname -s)" in
    Darwin) platform='darwin' ;;
    Linux) platform='linux' ;;
    *) fail 'This installer supports macOS and Linux. Download a Windows archive manually.' ;;
  esac

  case "$(uname -m)" in
    arm64|aarch64) architecture='arm64' ;;
    x86_64|amd64) architecture='x64' ;;
    *) fail "Unsupported CPU architecture: $(uname -m)" ;;
  esac

  if [ -z "$VERSION" ]; then
    latest_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$RELEASES_URL/latest") ||
      fail 'Unable to resolve the latest release.'
    case "$latest_url" in
      "$RELEASES_URL/tag/"*) VERSION=${latest_url#"$RELEASES_URL/tag/"} ;;
      *) fail 'The server returned an unexpected latest-release URL.' ;;
    esac
  fi
  valid_version "$VERSION" || fail "Invalid version: $VERSION. Expected vX.Y.Z."

  archive_name="$BINARY_NAME-$VERSION-$platform-$architecture.tar.gz"
  release_url="$RELEASES_URL/download/$VERSION"
  work_dir=$(mktemp -d "${TMPDIR:-/tmp}/flash-install.XXXXXX")
  archive_path="$work_dir/$archive_name"
  manifest_path="$work_dir/SHA256SUMS"

  curl -fsSL "$release_url/SHA256SUMS" -o "$manifest_path" || fail 'Unable to download SHA256SUMS.'
  curl -fsSL "$release_url/$archive_name" -o "$archive_path" || fail "Unable to download $archive_name."

  expected_checksum=$(awk -v name="$archive_name" '
    $2 == name {
      count++
      checksum = $1
      if (NF != 2 || length(checksum) != 64 || checksum ~ /[^0-9a-f]/ || $0 != checksum "  " name) {
        invalid = 1
      }
    }
    END {
      if (count != 1 || invalid) exit 1
      print checksum
    }
  ' "$manifest_path") || fail "SHA256SUMS must contain exactly one valid entry for $archive_name."

  if [ "$checksum_command" = 'sha256sum' ]; then
    checksum_output=$(sha256sum "$archive_path")
  else
    checksum_output=$(shasum -a 256 "$archive_path")
  fi
  actual_checksum=${checksum_output%% *}
  [ "$actual_checksum" = "$expected_checksum" ] || fail "Checksum mismatch for $archive_name."

  tar -xzf "$archive_path" -C "$work_dir" "$BINARY_NAME" || fail 'Unable to extract flash from the verified archive.'
  [ -f "$work_dir/$BINARY_NAME" ] && [ ! -L "$work_dir/$BINARY_NAME" ] ||
    fail 'The archive did not contain a regular flash binary.'

  mkdir -p "$INSTALL_DIR" || fail "Unable to create installation directory: $INSTALL_DIR"
  destination="$INSTALL_DIR/$BINARY_NAME"
  [ ! -d "$destination" ] || fail "Installation destination is a directory: $destination"
  staging_file=$(mktemp "$INSTALL_DIR/.flash.XXXXXX")
  cp "$work_dir/$BINARY_NAME" "$staging_file"
  chmod 0755 "$staging_file"
  mv -f "$staging_file" "$destination"
  staging_file=''

  printf 'Installed flash %s to %s\n' "$VERSION" "$destination"
  case ":${PATH:-}:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      printf 'Add the installation directory to your PATH:\n'
      printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
      ;;
  esac
}

main "$@"
