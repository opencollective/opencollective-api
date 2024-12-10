#!/bin/bash

echo -n "$@"
read -e answer
for response in y Y yes YES Yes Sure sure SURE OK ok Ok; do
  if [ "$answer" == "$response" ]; then
    exit 0
  fi
done

# Any answer other than the list above is considered a "no" answer
exit 1
