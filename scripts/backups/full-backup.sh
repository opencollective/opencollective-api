#!/bin/bash

# Exit on error, unset variables, and pipefail (prevents errors from being masked)
set -euo pipefail

# Configuration
S3_BUCKETS=(
  "opencollective-production"
  "opencollective-production-us-tax-forms"
)

HEROKU_APP="opencollective-prod-api"
METABASE_APP="oc-metabase"
HEROKU_APPS=(
  "opencollective-prod-api"
  "oc-prod-frontend"
  "oc-metabase"
  "oc-prod-pdf"
  "oc-prod-ml"
  "oc-prod-rest-api"
)
REQUIRED_SPACE_GB=300
REQUIRED_SPACE_BYTES=$((REQUIRED_SPACE_GB * 1024 * 1024 * 1024))

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

usage() {
  echo ""
  echo "This script creates a full cold backup of Open Collective production services."
  echo "It backs up Heroku Postgres databases, Metabase database, environment variables,"
  echo "and AWS S3 buckets to an encrypted archive."
  echo ""
  echo "Usage:"
  echo "  ./full-backup.sh [--tmp=/path/to/tmp] [--update] /path/to/export/directory"
  echo ""
  echo "Options:"
  echo "  --tmp=/path/to/tmp    Temporary directory for backup files (default: /tmp/oc-backup-\$DATE)"
  echo "  --update              Update existing backup by extracting most recent archive first for faster sync"
  echo "  --skip-space-check    Skip disk space check"
  echo ""
  echo "The export path must be a directory. The script will create a file named"
  echo "YYYY-MM-DD.7z in that directory (e.g., 2024-01-15.7z)."
  echo ""
  echo "The script supports resume capability - if interrupted, simply run it again"
  echo "with the same export directory and it will continue from where it left off."
  echo ""
  echo "When --update is used, the script will find the most recent .7z file in the"
  echo "export directory and use it as the base. The existing archive will be extracted"
  echo "to the temp directory before syncing, which makes aws sync much faster by"
  echo "only syncing changes."
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

check_disk_space() {
  local path=$1
  local available_bytes
  local available_gb
  
  if [ ! -d "$path" ]; then
    log_error "Path does not exist: $path"
    exit 1
  fi
  
  available_bytes=$(df -B1 "$path" | tail -1 | awk '{print $4}')
  available_gb=$((available_bytes / 1024 / 1024 / 1024))
  
  if [ "$available_bytes" -lt "$REQUIRED_SPACE_BYTES" ]; then
    log_error "Insufficient disk space on $path"
    log_error "Required: ${REQUIRED_SPACE_GB}GB, Available: ${available_gb}GB"
    exit 1
  fi
  
  log_info "Disk space check passed for $path (${available_gb}GB available)"
}

check_heroku_auth() {
  log_info "Checking Heroku authentication..."
  if ! heroku auth:whoami &> /dev/null; then
    log_error "Not authenticated with Heroku. Please run 'heroku login' first."
    exit 1
  fi
  local heroku_user=$(heroku auth:whoami)
  log_info "Heroku authenticated as: $heroku_user"
}

check_aws_config() {
  log_info "Checking AWS configuration..."
  if ! aws sts get-caller-identity &> /dev/null; then
    log_error "AWS CLI is not configured. Please configure AWS credentials first with 'aws configure'."
    exit 1
  fi
  local aws_account=$(aws sts get-caller-identity --query Account --output text)
  local aws_user=$(aws sts get-caller-identity --query Arn --output text)
  log_info "AWS authenticated - Account: $aws_account, User: $aws_user"
}

prompt_encryption_key() {
  echo ""
  read -sp "Enter encryption key for the backup: " ENCRYPTION_KEY
  echo ""
  if [ -z "$ENCRYPTION_KEY" ]; then
    log_error "Encryption key cannot be empty"
    exit 1
  fi
  read -sp "Confirm encryption key: " ENCRYPTION_KEY_CONFIRM
  echo ""
  if [ "$ENCRYPTION_KEY" != "$ENCRYPTION_KEY_CONFIRM" ]; then
    log_error "Encryption keys do not match"
    exit 1
  fi
  log_info "Encryption key confirmed"
}

get_state() {
  local key=$1
  if [ -f "$STATE_FILE" ]; then
    grep "^${key}=" "$STATE_FILE" | cut -d'=' -f2- || echo ""
  else
    echo ""
  fi
}

set_state() {
  local key=$1
  local value=$2
  if [ ! -f "$STATE_FILE" ]; then
    touch "$STATE_FILE"
  fi
  if grep -q "^${key}=" "$STATE_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$STATE_FILE"
  else
    echo "${key}=${value}" >> "$STATE_FILE"
  fi
}

is_step_complete() {
  local step=$1
  [ "$(get_state "$step")" = "complete" ]
}

mark_step_complete() {
  local step=$1
  set_state "$step" "complete"
  log_info "Step '$step' completed"
}

fetch_heroku_backup() {
  local step="heroku_backup"
  local app_dir="$TEMP_DIR/heroku/$HEROKU_APP"
  local dump_file="$app_dir/postgres_${DATE}.dump"
  
  if is_step_complete "$step"; then
    log_info "Heroku backup already completed, skipping..."
    return 0
  fi
  
  log_info "Fetching Heroku Postgres backup..."
  mkdir -p "$app_dir"
  
  # Change to app directory to download latest.dump there
  local original_dir=$(pwd)
  cd "$app_dir"
  
  if heroku pg:backups:download -a "$HEROKU_APP"; then
    if [ -f "latest.dump" ]; then
      mv "latest.dump" "$dump_file"
      cd "$original_dir"
      local size=$(du -h "$dump_file" | cut -f1)
      log_info "Heroku backup downloaded successfully (${size})"
      mark_step_complete "$step"
    else
      cd "$original_dir"
      log_error "Heroku backup file not found after download"
      exit 1
    fi
  else
    cd "$original_dir"
    log_error "Failed to download Heroku backup"
    exit 1
  fi
}

fetch_metabase_backup() {
  local step="metabase_backup"
  local app_dir="$TEMP_DIR/heroku/$METABASE_APP"
  local dump_file="$app_dir/postgres_${DATE}.dump"
  
  if is_step_complete "$step"; then
    log_info "Metabase backup already completed, skipping..."
    return 0
  fi
  
  log_info "Fetching Metabase database backup..."
  mkdir -p "$app_dir"
  
  # Change to app directory to download latest.dump there
  local original_dir=$(pwd)
  cd "$app_dir"
  
  if heroku pg:backups:download -a "$METABASE_APP"; then
    if [ -f "latest.dump" ]; then
      mv "latest.dump" "$dump_file"
      cd "$original_dir"
      local size=$(du -h "$dump_file" | cut -f1)
      log_info "Metabase backup downloaded successfully (${size})"
      mark_step_complete "$step"
    else
      cd "$original_dir"
      log_error "Metabase backup file not found after download"
      exit 1
    fi
  else
    cd "$original_dir"
    log_error "Failed to download Metabase backup"
    exit 1
  fi
}

fetch_env_files() {
  local step="env_files"
  
  if is_step_complete "$step"; then
    log_info "Environment files already backed up, skipping..."
    return 0
  fi
  
  log_info "Backing up environment variables..."
  
  for app in "${HEROKU_APPS[@]}"; do
    local app_dir="$TEMP_DIR/heroku/$app"
    local env_file="$app_dir/.env_${DATE}"
    
    mkdir -p "$app_dir"
    log_info "Fetching environment variables for: $app"
    
    if heroku config -s -a "$app" > "$env_file"; then
      if [ -s "$env_file" ]; then
        local size=$(du -h "$env_file" | cut -f1)
        log_info "Environment variables for $app saved (${size})"
      else
        log_warn "Environment file for $app is empty"
      fi
    else
      log_error "Failed to fetch environment variables for: $app"
      exit 1
    fi
  done
  
  mark_step_complete "$step"
}

fetch_s3_bucket() {
  local bucket=$1
  local step="s3_bucket_${bucket}"
  local bucket_dir="$TEMP_DIR/s3-buckets/$bucket"
  
  if is_step_complete "$step"; then
    log_info "S3 bucket '$bucket' already synced, skipping..."
    return 0
  fi
  
  log_info "Syncing S3 bucket: $bucket"
  mkdir -p "$bucket_dir"
  
  if aws s3 sync "s3://$bucket" "$bucket_dir" --exclude 'trash/*'; then
    local size=$(du -sh "$bucket_dir" | cut -f1)
    log_info "S3 bucket '$bucket' synced successfully (${size})"
  else
    # aws s3 sync returns non-zero when some files fail (e.g. filename too long for filesystem)
    # Continue anyway - partial sync is acceptable for backup purposes
    local size=$(du -sh "$bucket_dir" | cut -f1)
    log_warn "S3 bucket '$bucket' sync completed with some skipped files (e.g. filename too long). Synced: ${size}"
  fi
  mark_step_complete "$step"
}

extract_existing_archive() {
  local archive_path=$1
  log_info "Extracting S3 buckets from existing archive to temp directory for faster sync..."
  
  if [ ! -f "$archive_path" ]; then
    log_error "Archive file does not exist: $archive_path"
    log_error "Cannot use --update without an existing archive"
    exit 1
  fi
  
  log_info "Extracting S3 buckets from archive $archive_path to $TEMP_DIR..."
  
  # Extract only the s3-buckets directory from the archive
  # -o: output directory
  # -y: assume yes on all queries
  # "s3-buckets/*": Only extract files matching this path pattern
  if 7z x -o"$TEMP_DIR" -y -p"$ENCRYPTION_KEY" "$archive_path" "s3-buckets/*" &> /dev/null; then
    log_info "S3 buckets extracted successfully"
  else
    log_error "Failed to extract S3 buckets from archive. Please check the encryption key."
    exit 1
  fi
}

fetch_all_s3_buckets() {
  log_info "Fetching AWS S3 buckets..."
  for bucket in "${S3_BUCKETS[@]}"; do
    fetch_s3_bucket "$bucket"
  done
}

create_archive() {
  local step="archive_created"
  
  if is_step_complete "$step"; then
    log_info "Archive already created, skipping..."
    return 0
  fi
  
  log_info "Copying README.md into backup directory..."
  local script_dir=$(dirname "$(readlink -f "$0")")
  if [ -f "$script_dir/README.md" ]; then
    cp "$script_dir/README.md" "$TEMP_DIR/"
    log_info "README.md included in backup"
  else
    log_warn "README.md not found, archive will be created without it"
  fi
  
  log_info "Creating encrypted 7zip archive (this may take a while)..."
  
  # Create archive with fastest compression and encryption
  # -t7z: 7z format
  # -m0=lzma2: LZMA2 compression method
  # -mx=1: Fastest compression level (prioritizes speed over size)
  # -ms=on: Solid archive
  # -p: Password (encryption key)
  # -mhe=on: Encrypt headers (stronger security)
  if 7z a -t7z -m0=lzma2 -mx=1 -ms=on -p"$ENCRYPTION_KEY" -mhe=on -x!$STATE_FILE "$EXPORT_PATH" "$TEMP_DIR"/*; then
    local archive_size=$(du -h "$EXPORT_PATH" | cut -f1)
    log_info "Archive created successfully: $EXPORT_PATH (${archive_size})"
    
    log_info "Verifying archive integrity..."
    if 7z t -p"$ENCRYPTION_KEY" "$EXPORT_PATH" &> /dev/null; then
      log_info "Archive integrity verified"
      mark_step_complete "$step"
    else
      log_error "Archive integrity check failed"
      exit 1
    fi
  else
    log_error "Failed to create archive"
    exit 1
  fi
}

cleanup() {
  log_info "Cleaning up temporary files..."
  if [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
    log_info "Temporary directory removed"
  fi
}

main() {
  # Parse arguments
  TEMP_DIR_OVERRIDE=""
  EXPORT_PATH=""
  UPDATE_MODE=false
  SKIP_SPACE_CHECK=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --tmp=*)
        TEMP_DIR_OVERRIDE="${1#*=}"
        shift
        ;;
      --tmp)
        if [ $# -lt 2 ]; then
          log_error "Option --tmp requires a value"
          usage
        fi
        TEMP_DIR_OVERRIDE="$2"
        shift 2
        ;;
      --update)
        UPDATE_MODE=true
        shift
        ;;
      --skip-space-check)
        SKIP_SPACE_CHECK=true
        shift
        ;;
      -*)
        log_error "Unknown option: $1"
        usage
        ;;
      *)
        if [ -z "$EXPORT_PATH" ]; then
          EXPORT_PATH="$1"
        else
          log_error "Unexpected argument: $1"
          usage
        fi
        shift
        ;;
    esac
  done
  
  if [ -z "$EXPORT_PATH" ]; then
    log_error "Export path is required"
    usage
  fi
  
  EXPORT_DIR="$EXPORT_PATH"
  
  # Validate export directory
  if [ ! -d "$EXPORT_DIR" ]; then
    log_error "Export directory does not exist: $EXPORT_DIR"
    exit 1
  fi
  
  # Generate filename based on current date: YYYY-MM-DD.7z
  DATE=$(date +"%Y-%m-%d")
  EXPORT_FILE="${DATE}.7z"
  EXPORT_PATH="${EXPORT_DIR}/${EXPORT_FILE}"
  
  # Handle --update mode: find the most recent .7z file in the directory
  BASE_ARCHIVE=""
  if [ "$UPDATE_MODE" = true ]; then
    # Find the most recent .7z file in the directory
    # Use shopt -s nullglob to handle case where no .7z files exist
    shopt -s nullglob
    for file in "$EXPORT_DIR"/*.7z; do
      if [ -z "$BASE_ARCHIVE" ] || [ "$file" -nt "$BASE_ARCHIVE" ]; then
        BASE_ARCHIVE="$file"
      fi
    done
    shopt -u nullglob
    
    if [ -z "$BASE_ARCHIVE" ] || [ ! -f "$BASE_ARCHIVE" ]; then
      log_error "No existing .7z archive found in directory: $EXPORT_DIR"
      log_error "Cannot use --update without an existing archive"
      exit 1
    fi
    
    # Check if the target archive is the same as the extracted one
    if [ "$BASE_ARCHIVE" = "$EXPORT_PATH" ]; then
      log_error "Target archive is the same as the extracted archive: $EXPORT_PATH"
      log_error "Cannot use --update when the most recent archive is the one that would be created today"
      log_error "Please use a different export directory or remove the existing archive first"
      exit 1
    fi
    
    # Use the most recent archive as the base for extraction
    # But still create a new archive with today's date
    log_info "Update mode enabled - using most recent archive as base: $(basename "$BASE_ARCHIVE")"
    log_info "Will extract existing archive first for faster sync"
    log_info "New archive will be created: $EXPORT_FILE"
  elif [ -f "$EXPORT_PATH" ]; then
    log_warn "Export file already exists: $EXPORT_PATH"
    read -p "Overwrite? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      log_info "Aborted by user"
      exit 0
    fi
    rm -f "$EXPORT_PATH"
  fi
  
  log_info "Starting full backup process..."
  log_info "Export directory: $EXPORT_DIR"
  log_info "Export file: $EXPORT_FILE"
  
  # Check required commands
  log_info "Checking required commands..."
  check_command "heroku"
  check_command "aws"
  check_command "7z"
  
  # Check authentication
  check_heroku_auth
  check_aws_config
  
  
  # Setup temp directory and state file
  # DATE is already set above for the export filename
  if [ -n "$TEMP_DIR_OVERRIDE" ]; then
    TEMP_DIR="$TEMP_DIR_OVERRIDE"
  else
    TEMP_DIR="/tmp/oc-backup-$DATE"
  fi
  STATE_FILE="$TEMP_DIR/.backup-state"
  
  # Check disk space
  log_info "Checking disk space..."
  TEMP_DIR_PARENT=$(dirname "$TEMP_DIR")
  if [ ! -d "$TEMP_DIR_PARENT" ]; then
    log_error "Parent directory of temp directory does not exist: $TEMP_DIR_PARENT"
    exit 1
  fi
  if [ "$SKIP_SPACE_CHECK" = false ]; then
    check_disk_space "$TEMP_DIR_PARENT"
    check_disk_space "$EXPORT_DIR"
  fi
  
  mkdir -p "$TEMP_DIR"
  log_info "Using temporary directory: $TEMP_DIR"
  
  prompt_encryption_key

  # Extract existing archive if in update mode
  if [ "$UPDATE_MODE" = true ]; then
    extract_existing_archive "$BASE_ARCHIVE"
  fi
  
  # Check if this is a resume
  if [ -f "$STATE_FILE" ]; then
    log_info "Resume detected - continuing from previous backup attempt"
  fi
  
  # Fetch data
  fetch_env_files
  fetch_heroku_backup
  fetch_metabase_backup
  fetch_all_s3_buckets
  
  # Create archive
  create_archive
  
  # Cleanup
  cleanup
  
  log_info ""
  log_info "Backup completed successfully!"
  log_info "Archive location: $EXPORT_PATH"
  log_info ""
  log_info "To restore this backup, see the README.md included in the archive"
  log_info "or refer to scripts/backups/README.md"
}

# Run main function
main "$@"

