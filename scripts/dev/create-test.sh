#!/bin/bash
# Create a test file with minimal content for the given source file

set -e

usage() {
  echo ""
  echo "This script creates a test file with minimal content for the given source file."
  echo ""
  echo "Usage:"
  echo "       create-test.sh <source-file>"
  echo ""
  exit 0
}

SOURCE_FILE="$1"
if [ -z "$SOURCE_FILE" ]; then usage; fi

# Exit if source file doesn't exist
if [ ! -f $SOURCE_FILE ]; then
  echo "Error: Source file $SOURCE_FILE doesn't exist. Remember to provide a relative path from the project root."
  exit 1
fi

# Create the folder hierarchy if it doesn't exist
SOURCE_FILE_FOLDER=$(dirname $SOURCE_FILE)
echo "Creating test folder in test/$SOURCE_FILE_FOLDER..."
mkdir -p test/$SOURCE_FILE_FOLDER

# Create the test file using the multi-line string template below
echo "Creating test file for $SOURCE_FILE..."
TEST_NAME=$(basename $SOURCE_FILE | sed 's/\.[^.]*$//')
OUT_PATH=test/$SOURCE_FILE_FOLDER/$TEST_NAME.test.ts
DEPTH=$(echo $SOURCE_FILE_FOLDER | tr -cd '/' | wc -c)

echo """
import { expect } from 'chai';

import ___ from '$(printf '../../../%.0s' $(seq 1 $((DEPTH))))$SOURCE_FILE_FOLDER/$TEST_NAME';

describe('$SOURCE_FILE_FOLDER/$TEST_NAME', () => {
  it('should pass', () => {
    expect(true).to.be.true;
  });
});

""" >$OUT_PATH

echo "Test file created at $OUT_PATH"
