#!/usr/bin/env bash
# Resolve the digest of a GHCR candidate image that this workflow just pushed.
#
# The digest is containerimage.digest from `docker buildx build --metadata-file`.
# That is the manifest the push stored, and it is the same field
# docker/build-push-action publishes as its digest output. A registry read
# afterwards only confirms the tag points at that digest.
#
# Do not "simplify" the confirmation back into:
#
#   docker buildx imagetools inspect "$IMAGE" | awk '/^Digest:/ {print $2; exit}'
#
# under `set -o pipefail`. awk exits at the first Digest line and closes the
# pipe while buildx is still writing the manifest list. The plugin is killed
# by SIGPIPE, the docker CLI turns that signal death into exit 255, and it
# prints nothing. Run 37286481317 failed that way after the push had already
# succeeded. Capture the full inspect output, then parse it.
set -euo pipefail

usage() {
  echo "usage: ghcr-candidate-digest.sh from-metadata <file> | confirm | self-test" >&2
}

# sha256 digest buildx recorded for the pushed manifest. Refuses a metadata
# file whose index digest and descriptor digest disagree, so a config digest
# cannot be reported in place of the tag digest.
from_metadata() {
  local file="$1"
  local digest="" descriptor="" err

  if [[ ! -f "$file" ]]; then
    echo "::error::Build metadata file not found: ${file}" >&2
    return 1
  fi

  err="$(mktemp)"
  if ! digest="$(jq -r '.["containerimage.digest"] // empty' "$file" 2>"$err")"; then
    echo "::error::Could not read build metadata as JSON: ${file}" >&2
    cat "$err" >&2
    rm -f "$err"
    return 1
  fi
  if ! descriptor="$(jq -r '.["containerimage.descriptor"].digest // empty' "$file" 2>"$err")"; then
    echo "::error::Could not read build metadata as JSON: ${file}" >&2
    cat "$err" >&2
    rm -f "$err"
    return 1
  fi
  rm -f "$err"

  if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "::error::Build metadata has no containerimage.digest (sha256:<64 hex>); got '${digest:-empty}'. This is the field docker/build-push-action outputs." >&2
    echo "metadata keys: $(jq -r 'keys | join(",")' "$file" 2>/dev/null || echo unreadable)" >&2
    return 1
  fi
  if [[ -n "$descriptor" && "$descriptor" != "$digest" ]]; then
    echo "::error::containerimage.digest (${digest}) does not match containerimage.descriptor.digest (${descriptor}). Refusing to guess which digest the tag points at." >&2
    return 1
  fi
  printf '%s\n' "$digest"
}

# First "Digest:" line of plain `imagetools inspect` output. That line is the
# manifest-list / index digest the tag points at. Later indented Digest lines
# are child manifests (the image, the attestation) and are not the tag digest.
digest_from_inspect_text() {
  local text="$1"
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^Digest:[[:space:]]*(sha256:[a-f0-9]{64})[[:space:]]*$ ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
      return 0
    fi
  done <<< "$text"
  return 1
}

# Registry read. Tests point GHCR_IMAGETOOLS_INSPECT at a fake executable.
inspect_image() {
  local image="$1"
  if [[ -n "${GHCR_IMAGETOOLS_INSPECT:-}" ]]; then
    "$GHCR_IMAGETOOLS_INSPECT" "$image"
  else
    docker buildx imagetools inspect "$image"
  fi
}

confirm_digest() {
  local image="${IMAGE:-}"
  local expected="${EXPECTED_DIGEST:-}"
  local attempts="${GHCR_DIGEST_CONFIRM_ATTEMPTS:-5}"
  local delay="${GHCR_DIGEST_CONFIRM_DELAY_SECONDS:-2}"
  local attempt=0 output="" status=0 digest="" errfile

  if [[ ! "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]*$ ]]; then
    echo "::error::Refusing to inspect an unexpected image reference." >&2
    return 1
  fi
  if [[ ! "$expected" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "::error::Expected digest is not sha256:<64 hex> (got '${expected}')." >&2
    return 1
  fi
  if [[ ! "$attempts" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::GHCR_DIGEST_CONFIRM_ATTEMPTS must be a positive integer." >&2
    return 1
  fi
  if [[ ! "$delay" =~ ^[0-9]+$ ]]; then
    echo "::error::GHCR_DIGEST_CONFIRM_DELAY_SECONDS must be a non-negative integer." >&2
    return 1
  fi

  errfile="$(mktemp)"
  # shellcheck disable=SC2064
  trap 'rm -f "'"$errfile"'"' RETURN

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    # The full inspect text is captured here. Nothing on this command line
    # exits early, so buildx cannot die with SIGPIPE.
    set +e
    output="$(inspect_image "$image" 2>"$errfile")"
    status=$?
    set -e

    if [[ "$status" -eq 0 ]]; then
      digest=""
      if digest="$(digest_from_inspect_text "$output")"; then
        if [[ "$digest" == "$expected" ]]; then
          echo "Confirmed ${image}@${expected}"
          return 0
        fi
        echo "::warning::Attempt ${attempt}/${attempts}: ${image} resolved to ${digest}, expected ${expected}." >&2
      else
        echo "::warning::Attempt ${attempt}/${attempts}: inspect succeeded but its output had no index digest line for ${image}." >&2
      fi
    else
      echo "::warning::Attempt ${attempt}/${attempts}: docker buildx imagetools inspect exited ${status} for ${image}." >&2
      if [[ -s "$errfile" ]]; then
        sed 's/^/inspect: /' "$errfile" >&2
      else
        echo "inspect: no stderr. Exit ${status} with empty stderr is what the docker CLI reports when the buildx plugin is killed by SIGPIPE." >&2
      fi
    fi

    if [[ "$attempt" -lt "$attempts" && "$delay" -gt 0 ]]; then
      echo "Tag ${image} was not readable as ${expected} yet; retrying in ${delay}s." >&2
      sleep "$delay"
      delay=$((delay * 2))
    fi
  done

  echo "::error::Push recorded ${expected} for ${image}, but the tag did not read back as that digest after ${attempts} attempts." >&2
  return 1
}

# Writes a Digest line and then more output than a pipe buffer. An awk that
# exits on the first Digest line closes the pipe; the writer then exits 255,
# which is the docker CLI's status for that SIGPIPE.
early_close_writer() {
  trap '' PIPE
  local digest="$1"
  local child="$2"
  local i
  printf 'Name: example\n' || exit 255
  printf 'MediaType: application/vnd.oci.image.index.v1+json\n' || exit 255
  printf 'Digest: %s\n' "$digest" || exit 255
  for ((i = 0; i < 8000; i++)); do
    printf 'padding %s Digest: %s\n' "$i" "$child" || exit 255
  done
}

self_test() {
  local tmp d1 d2 parsed status got err out
  tmp="$(mktemp -d)"
  err="$(mktemp)"
  # EXIT, not RETURN: a RETURN trap also runs when from_metadata and
  # confirm_digest return, which would delete this directory mid-test.
  # shellcheck disable=SC2064
  trap 'rm -rf "'"$tmp"'"; rm -f "'"$err"'"' EXIT
  d1="sha256:$(printf 'a%.0s' {1..64})"
  d2="sha256:$(printf 'b%.0s' {1..64})"

  jq -n --arg d "$d1" '{
    "containerimage.digest": $d,
    "containerimage.descriptor": {"digest": $d, "mediaType": "application/vnd.oci.image.index.v1+json"}
  }' > "$tmp/ok.json"
  parsed="$(from_metadata "$tmp/ok.json")"
  [[ "$parsed" == "$d1" ]] || {
    echo "metadata digest mismatch: $parsed" >&2
    return 1
  }

  jq -n --arg d "$d1" '{"containerimage.config.digest": $d}' > "$tmp/config-only.json"
  set +e
  out="$(from_metadata "$tmp/config-only.json" 2>"$err")"
  status=$?
  set -e
  [[ "$status" -ne 0 && -z "$out" ]] || {
    echo "config digest was accepted: status=$status out=$out" >&2
    return 1
  }
  grep -q 'containerimage.digest' "$err" || {
    echo "missing-digest error did not name the field" >&2
    cat "$err" >&2
    return 1
  }

  jq -n --arg a "$d1" --arg b "$d2" '{
    "containerimage.digest": $a,
    "containerimage.descriptor": {"digest": $b}
  }' > "$tmp/disagree.json"
  set +e
  out="$(from_metadata "$tmp/disagree.json" 2>"$err")"
  status=$?
  set -e
  [[ "$status" -ne 0 && -z "$out" ]] || {
    echo "disagreeing digests were accepted: status=$status out=$out" >&2
    return 1
  }

  echo '{' > "$tmp/bad.json"
  set +e
  out="$(from_metadata "$tmp/bad.json" 2>"$err")"
  status=$?
  set -e
  [[ "$status" -ne 0 && -z "$out" ]] || {
    echo "invalid JSON was accepted" >&2
    return 1
  }

  set +e
  out="$(from_metadata "$tmp/missing.json" 2>"$err")"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || {
    echo "missing file was accepted" >&2
    return 1
  }

  local inspect_text
  # Shape of `docker buildx imagetools inspect` on v0.37.1 (the runner that
  # failed): tabwriter aligns the index digest, and child manifests are
  # indented Name lines whose reference contains a different digest.
  inspect_text="$(printf 'Name:      ghcr.io/example/app:sha-abc\nMediaType: application/vnd.oci.image.index.v1+json\nDigest:    %s\n\nManifests:\n  Name:      ghcr.io/example/app:sha-abc@%s\n  MediaType: application/vnd.oci.image.manifest.v1+json\n  Platform:  linux/amd64\n' "$d1" "$d2")"
  parsed="$(digest_from_inspect_text "$inspect_text")"
  [[ "$parsed" == "$d1" ]] || {
    echo "inspect parser picked $parsed, wanted the index digest" >&2
    return 1
  }
  if digest_from_inspect_text "Name: no digest here"$'\n'"  Digest: ${d2}"; then
    echo "indented child digest was treated as the index digest" >&2
    return 1
  fi

  # The failure mode from run 37286481317: the digest is parsed, then the
  # pipeline still fails with 255 because the writer was closed early.
  set +e
  got="$(early_close_writer "$d1" "$d2" 2>/dev/null | awk '/^Digest:/ {print $2; exit}')"
  status=$?
  set -e
  [[ "$status" -eq 255 && "$got" == "$d1" ]] || {
    echo "early-close pipeline: status=$status digest=${got:-empty} (want 255 and ${d1})" >&2
    return 1
  }

  # Capturing the whole stream, then parsing, keeps the writer alive and
  # returns the index digest.
  set +e
  out="$(early_close_writer "$d1" "$d2")"
  status=$?
  set -e
  parsed="$(digest_from_inspect_text "$out")"
  [[ "$status" -eq 0 && "$parsed" == "$d1" ]] || {
    echo "full capture failed: status=$status digest=${parsed:-empty}" >&2
    return 1
  }

  cat > "$tmp/inspect.sh" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
image="$1"
dir="$(cd "$(dirname "$0")" && pwd)"
count=0
if [[ -f "$dir/count" ]]; then
  count="$(cat "$dir/count")"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$dir/count"
fail_until="$(cat "$dir/fail_until")"
mode="$(cat "$dir/mode")"
good="$(cat "$dir/good")"
child="$(cat "$dir/child")"
if [[ "$count" -le "$fail_until" ]]; then
  if [[ "$mode" == "silent-255" ]]; then
    exit 255
  fi
  echo "simulated manifest unknown" >&2
  exit 1
fi
if [[ "$mode" == "always-wrong" ]]; then
  good="$(cat "$dir/wrong")"
elif [[ "$mode" == "mismatch-once" && "$count" -eq $((fail_until + 1)) ]]; then
  good="$(cat "$dir/wrong")"
fi
printf 'Name: %s\nMediaType: application/vnd.oci.image.index.v1+json\nDigest: %s\n\nManifests:\n  Digest: %s\n' "$image" "$good" "$child"
EOF
  chmod +x "$tmp/inspect.sh"
  printf '%s\n' "$d1" > "$tmp/good"
  printf '%s\n' "$d2" > "$tmp/child"
  printf '%s\n' "$d2" > "$tmp/wrong"

  export GHCR_IMAGETOOLS_INSPECT="$tmp/inspect.sh"
  export GHCR_DIGEST_CONFIRM_ATTEMPTS=4
  export GHCR_DIGEST_CONFIRM_DELAY_SECONDS=0
  export IMAGE="ghcr.io/example/app:sha-abcdef0"
  export EXPECTED_DIGEST="$d1"

  printf '%s\n' 2 > "$tmp/fail_until"
  printf '%s\n' silent-255 > "$tmp/mode"
  rm -f "$tmp/count"
  confirm_digest >/dev/null 2>"$err"
  grep -q 'exited 255' "$err" || {
    echo "retry did not report exit 255" >&2
    cat "$err" >&2
    return 1
  }
  grep -q 'no stderr' "$err" || {
    echo "retry did not explain an empty inspect stderr" >&2
    cat "$err" >&2
    return 1
  }

  printf '%s\n' 0 > "$tmp/fail_until"
  printf '%s\n' mismatch-once > "$tmp/mode"
  rm -f "$tmp/count"
  confirm_digest >/dev/null 2>"$err"
  grep -q 'resolved to' "$err" || {
    echo "mismatch retry did not report the digest it actually read" >&2
    cat "$err" >&2
    return 1
  }

  printf '%s\n' 0 > "$tmp/fail_until"
  printf '%s\n' always-wrong > "$tmp/mode"
  rm -f "$tmp/count"
  set +e
  out="$(confirm_digest 2>"$err")"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || {
    echo "persistent mismatch was confirmed" >&2
    return 1
  }
  grep -q "$d1" "$err" || {
    echo "mismatch error omitted the recorded digest" >&2
    cat "$err" >&2
    return 1
  }
  grep -q 'did not read back' "$err" || {
    echo "mismatch error was not explicit" >&2
    cat "$err" >&2
    return 1
  }

  rm -f "$err"
  echo "self-test ok"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    from-metadata)
      shift
      from_metadata "${1:?metadata file required}"
      ;;
    confirm)
      confirm_digest
      ;;
    self-test)
      self_test
      ;;
    *)
      usage
      return 2
      ;;
  esac
}

main "$@"
