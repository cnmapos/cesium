#!/usr/bin/env bash
set -euo pipefail

# Create a markdown file containing the full current code for changed files.
#
# Default mode is staged changes: read file content from the git index.
# The --changes/--unstaged mode reads file content from the working tree and
# also includes untracked files.
#
# Usage:
#   ./scripts/collect-staged-files-md.sh [output.md]
#   ./scripts/collect-staged-files-md.sh [--mode staged|changes|all] [output.md]
#   ./scripts/collect-staged-files-md.sh --staged [output.md]
#   ./scripts/collect-staged-files-md.sh --changes [output.md]
#   ./scripts/collect-staged-files-md.sh --all [output.md]
#
# Default output file:
#   staged mode:  staged-file-changes.md
#   changes mode: file-changes.md
#   all mode:     all-file-changes.md

mode="staged"
output_file=""

usage() {
  cat >&2 <<'USAGE'
Usage:
  ./scripts/collect-staged-files-md.sh [output.md]
  ./scripts/collect-staged-files-md.sh [--mode staged|changes|all] [output.md]
  ./scripts/collect-staged-files-md.sh --staged [output.md]
  ./scripts/collect-staged-files-md.sh --changes [output.md]
  ./scripts/collect-staged-files-md.sh --all [output.md]

Modes:
  --staged, -s       Collect staged changes from the git index. Default.
  --changes, -u      Collect unstaged working-tree changes plus untracked files.
  --unstaged         Alias for --changes.
  --all, -a          Collect all working-tree changes against HEAD plus untracked files.
  --help, -h         Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --mode; expected 'staged', 'changes', or 'all'." >&2
        exit 2
      fi
      mode="$1"
      ;;
    --mode=*)
      mode="${1#--mode=}"
      ;;
    --staged|-s)
      mode="staged"
      ;;
    --changes|--unstaged|-u)
      mode="changes"
      ;;
    --all|-a)
      mode="all"
      ;;
    staged|changes|all)
      mode="$1"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      if [[ $# -gt 0 ]]; then
        if [[ -n "$output_file" ]]; then
          echo "Only one output file can be specified." >&2
          exit 2
        fi
        output_file="$1"
        shift
        if [[ $# -gt 0 ]]; then
          echo "Unexpected extra arguments: $*" >&2
          exit 2
        fi
      fi
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      if [[ -n "$output_file" ]]; then
        echo "Only one output file can be specified." >&2
        exit 2
      fi
      output_file="$1"
      ;;
  esac
  shift
done

case "$mode" in
  staged|changes|all) ;;
  *)
    echo "Invalid mode: $mode; expected 'staged', 'changes', or 'all'." >&2
    exit 2
    ;;
esac

if [[ -z "$output_file" ]]; then
  case "$mode" in
    staged) output_file="staged-file-changes.md" ;;
    changes) output_file="file-changes.md" ;;
    all) output_file="all-file-changes.md" ;;
  esac
fi
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Convert output path to a repository-relative path when possible, so the
# generated markdown file is not included if it is already changed/staged.
output_abs="$(cd "$(dirname "$output_file")" && pwd)/$(basename "$output_file")"
repo_abs="$(pwd)"
output_rel=""
case "$output_abs" in
  "$repo_abs"/*) output_rel="${output_abs#"$repo_abs"/}" ;;
  "$repo_abs") output_rel="$(basename "$output_file")" ;;
esac

has_untracked_files() {
  [[ -n "$(git ls-files --others --exclude-standard)" ]]
}

case "$mode" in
  staged)
    if git diff --cached --quiet --exit-code; then
      echo "No staged changes found." >&2
      exit 1
    fi
    ;;
  changes)
    if git diff --quiet --exit-code && ! has_untracked_files; then
      echo "No unstaged changes or untracked files found." >&2
      exit 1
    fi
    ;;
  all)
    if git diff HEAD --quiet --exit-code && ! has_untracked_files; then
      echo "No changes or untracked files found." >&2
      exit 1
    fi
    ;;
esac

print_content() {
  local source_mode="$1"
  local path="$2"
  case "$source_mode" in
    staged)
      git show ":$path"
      ;;
    changes|all|worktree)
      if [[ -L "$path" ]]; then
        readlink "$path"
      else
        cat -- "$path"
      fi
      ;;
  esac
}

# Choose a markdown fence longer than any run of backticks in the file content.
make_fence() {
  local source_mode="$1"
  local path="$2"
  local max_ticks
  max_ticks="$(print_content "$source_mode" "$path" | awk '
    {
      line = $0
      while (match(line, /`+/)) {
        if (RLENGTH > max) max = RLENGTH
        line = substr(line, RSTART + RLENGTH)
      }
    }
    END { print max + 3 }
  ')"
  printf '%*s' "$max_ticks" '' | tr ' ' '`'
}

is_binary_path() {
  local source_mode="$1"
  local path="$2"
  local added deleted rest

  case "$source_mode" in
    staged)
      read -r added deleted rest < <(git diff --cached --numstat -- "$path" || true)
      [[ "$added" == "-" && "$deleted" == "-" ]]
      ;;
    changes)
      if [[ -L "$path" ]]; then
        return 1
      fi
      read -r added deleted rest < <(git diff --numstat -- "$path" || true)
      if [[ "$added" == "-" && "$deleted" == "-" ]]; then
        return 0
      fi
      # Untracked files do not appear in git diff --numstat.
      [[ -f "$path" ]] && ! LC_ALL=C grep -Iq "" -- "$path"
      ;;
    all)
      if [[ -L "$path" ]]; then
        return 1
      fi
      read -r added deleted rest < <(git diff HEAD --numstat -- "$path" || true)
      if [[ "$added" == "-" && "$deleted" == "-" ]]; then
        return 0
      fi
      [[ -f "$path" ]] && ! LC_ALL=C grep -Iq "" -- "$path"
      ;;
  esac
}

emit_file() {
  local status="$1"
  local path="$2"
  local source_mode="$3"

  # Do not include the generated output file itself if it is changed/staged.
  if [[ -n "$output_rel" && "$path" == "$output_rel" ]]; then
    return
  fi

  echo
  echo "## $path"
  echo

  # Skip deleted files because there is no full-file content to print.
  if [[ "$status" == D* || ! -e "$path" && "$source_mode" != "staged" ]]; then
    echo "Deleted file; no full file code available in this mode."
    return
  fi

  if is_binary_path "$source_mode" "$path"; then
    echo "Binary file; full file code omitted."
    return
  fi

  local fence
  fence="$(make_fence "$source_mode" "$path")"
  echo "$fence"
  print_content "$source_mode" "$path"
  echo
  echo "$fence"
}

emit_name_status_stream() {
  local source_mode="$1"
  local diff_args=()
  case "$source_mode" in
    staged) diff_args=(--cached --name-status -z) ;;
    changes) diff_args=(--name-status -z) ;;
    all) diff_args=(HEAD --name-status -z) ;;
  esac

  # Use --name-status -z so file names with spaces/newlines are handled safely.
  while IFS= read -r -d '' status; do
    local path=""
    local old_path=""

    case "$status" in
      R*|C*)
        IFS= read -r -d '' old_path
        IFS= read -r -d '' path
        ;;
      *)
        IFS= read -r -d '' path
        ;;
    esac

    emit_file "$status" "$path" "$source_mode"
  done < <(git diff "${diff_args[@]}")
}

emit_untracked_files() {
  while IFS= read -r -d '' path; do
    emit_file "A" "$path" "changes"
  done < <(git ls-files --others --exclude-standard -z)
}

{
  echo "# file changes"
  echo
  echo "Mode: $mode"

  case "$mode" in
    staged)
      emit_name_status_stream "staged"
      ;;
    changes)
      emit_name_status_stream "changes"
      emit_untracked_files
      ;;
    all)
      emit_name_status_stream "all"
      emit_untracked_files
      ;;
  esac
} > "$output_file"

echo "Created $output_file (mode: $mode)"



