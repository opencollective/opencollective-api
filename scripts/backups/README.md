# Open Collective Full Backup Restore Guide

This document explains how to restore a full cold backup created by `full-backup.sh`.

## Prerequisites

Before restoring a backup, ensure you have the following tools installed:

- **7zip** (`7z` command) - For extracting the encrypted archive
- **Heroku CLI** (`heroku` command) - For restoring the database
- **AWS CLI** (`aws` command) - For restoring S3 buckets
- **PostgreSQL client tools** - For database operations (if needed)

## Backup Archive Structure

The backup archive contains:

```
backup-YYYY-MM-DD/
├── README.md                    # This file
├── heroku/                      # Heroku backups organized by app
│   ├── opencollective-prod-api/
│   │   ├── postgres.dump        # Main production database dump
│   │   └── .env                 # Environment variables
│   ├── oc-prod-frontend/
│   │   └── .env                 # Environment variables
│   └── oc-metabase/
│       ├── postgres.dump        # Metabase database dump
│       └── .env                 # Environment variables
└── s3-buckets/                  # AWS S3 bucket contents
    ├── opencollective-production/
    └── opencollective-production-us-tax-forms/
```

## Restore Process

### Step 1: Extract the Encrypted Archive

You will need the encryption key that was used when creating the backup.

```bash
# Extract the archive
7z x -p"YOUR_ENCRYPTION_KEY" /path/to/backup.7z -o/tmp/backup-extracted

# Verify extraction
ls -lh /tmp/backup-extracted/
```

### Step 2: Restore process

Use the `heroku` (or `psql`), `aws` commands to restore the backup parts.

## Additional Resources

- [Heroku Postgres Backup and Restore](https://devcenter.heroku.com/articles/heroku-postgres-backups)
- [AWS S3 CLI Documentation](https://docs.aws.amazon.com/cli/latest/reference/s3/)
- [PostgreSQL Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
