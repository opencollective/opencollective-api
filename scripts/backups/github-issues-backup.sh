#!/bin/bash

# Backup all GitHub issues from opencollective/opencollective to JSON files (one per issue).
# Supports resume by skipping issues already present in the output directory (by issue number).

set -euo pipefail

GITHUB_REPO="opencollective/opencollective"
ISSUES_API="repos/${GITHUB_REPO}/issues"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

usage() {
  echo ""
  echo "Backup all GitHub issues from https://github.com/${GITHUB_REPO} to JSON files."
  echo "Each issue is stored as one file: {number}-{titleSlug}.md (JSON content)."
  echo "JSON shape: { \"issue\": <issue>, \"comments\": [<comment>, ...] }"
  echo ""
  echo "Usage:"
  echo "  ./github-issues-backup.sh /path/to/output/directory"
  echo ""
  echo "Requires GitHub CLI (gh) authenticated via 'gh auth login' or GH_TOKEN."
  echo "Requires jq."
  echo ""
  echo "Resume: re-run with the same output directory. Issues whose number already has a"
  echo "file (matching {number}-*.md) are skipped."
  echo ""
  exit 1
}

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

check_command() {
  if ! command -v "$1" &> /dev/null; then
    log_error "$1 command is not available. Please install it first."
    exit 1
  fi
}

check_gh_auth() {
  log_info "Checking GitHub CLI authentication..."
  if ! gh auth status &> /dev/null; then
    log_error "Not authenticated with GitHub. Run 'gh auth login' or set GH_TOKEN."
    exit 1
  fi
  log_info "GitHub CLI authenticated"
}

# URL-friendly slug from issue title (for filenames).
slugify_title() {
  local title="${1:-untitled}"
  local slug
  slug=$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | LC_ALL=C tr -cs 'a-z0-9' '-' | sed -e 's/^-//' -e 's/-$//' -e 's/-\+/-/g')
  if [ -z "$slug" ]; then
    slug="untitled"
  fi
  # Keep filenames within typical filesystem limits.
  printf '%s' "$slug" | cut -c1-100
}

# Highest issue number already present in the output directory.
get_last_issue_number() {
  local dir=$1
  local max_number=0
  local f base number

  shopt -s nullglob
  for f in "$dir"/*.md; do
    base=$(basename "$f")
    number="${base%%-*}"
    if [[ "$number" =~ ^[0-9]+$ ]] && [ "$number" -gt "$max_number" ]; then
      max_number=$number
    fi
  done
  shopt -u nullglob

  echo "$max_number"
}

issue_file_exists() {
  local dir=$1
  local issue_number=$2
  local match
  shopt -s nullglob
  match=("$dir/${issue_number}-"*.md)
  shopt -u nullglob
  [ "${#match[@]}" -gt 0 ]
}

fetch_issue_comments() {
  local issue_number=$1
  local comments_json

  if ! comments_json=$(gh api --paginate "repos/${GITHUB_REPO}/issues/${issue_number}/comments?per_page=100"); then
    log_error "Failed to fetch comments for issue #${issue_number}"
    return 1
  fi

  if ! echo "$comments_json" | jq -e 'type == "array"' >/dev/null; then
    log_error "Unexpected comments response for issue #${issue_number}"
    return 1
  fi

  echo "$comments_json"
}

write_issue_backup() {
  local dir=$1
  local issue_json=$2
  local number title slug outfile comments_json

  number=$(echo "$issue_json" | jq -r '.number')
  title=$(echo "$issue_json" | jq -r '.title // "untitled"')
  slug=$(slugify_title "$title")
  outfile="${dir}/${number}-${slug}.md"

  comments_json=$(fetch_issue_comments "$number")

  jq -n \
    --argjson issue "$issue_json" \
    --argjson comments "$comments_json" \
    '{issue: $issue, comments: $comments}' \
    | jq '.' > "$outfile"
  echo "$outfile"
}

if [ "${1:-}" = "" ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
fi

OUTPUT_DIR=$1

check_command gh
check_command jq
check_gh_auth

if [ -e "$OUTPUT_DIR" ] && [ ! -d "$OUTPUT_DIR" ]; then
  log_error "Output path exists but is not a directory: $OUTPUT_DIR"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

LAST_NUMBER=$(get_last_issue_number "$OUTPUT_DIR")
if [ "$LAST_NUMBER" -gt 0 ]; then
  log_info "Resuming backup (last issue number in output directory: #${LAST_NUMBER})"
else
  log_info "Starting fresh backup in $OUTPUT_DIR"
fi

log_info "Fetching issues from ${GITHUB_REPO} (state=all, excluding pull requests)..."

FETCHED=0
WRITTEN=0
SKIPPED=0

# Query params must be in the URL (or --method GET). Using -f/-F without --method GET
# switches the request to POST and GitHub responds with "title wasn't supplied".
fetch_and_process_issues() {
  local response
  if ! response=$(gh api --paginate "${ISSUES_API}?state=all&per_page=100"); then
    log_error "GitHub API request failed"
    return 1
  fi

  if ! echo "$response" | jq -e 'type == "array"' >/dev/null; then
    log_error "GitHub API returned an unexpected response:"
    echo "$response" | jq . >&2 2>/dev/null || echo "$response" >&2
    return 1
  fi

  while IFS= read -r issue_json; do
    FETCHED=$((FETCHED + 1))

    issue_number=$(echo "$issue_json" | jq -r '.number')

    if issue_file_exists "$OUTPUT_DIR" "$issue_number"; then
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    outfile=$(write_issue_backup "$OUTPUT_DIR" "$issue_json")
    WRITTEN=$((WRITTEN + 1))
    log_info "Saved #${issue_number} -> $(basename "$outfile")"

    if [ $((WRITTEN % 50)) -eq 0 ]; then
      log_info "Progress: ${WRITTEN} written, ${SKIPPED} skipped (${FETCHED} fetched)"
    fi
  done < <(echo "$response" | jq -c '.[] | select(type == "object" and (.pull_request | not))')
}

fetch_and_process_issues

log_info "Backup complete: ${WRITTEN} issues written, ${SKIPPED} skipped (${FETCHED} issues fetched)"
log_info "Output directory: $OUTPUT_DIR"
