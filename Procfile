web: node dist/index.js
worker: env ENABLE_SERVICE_SEARCH_SYNC=true ENABLE_SERVICE_SERVER=false PG_MIN_CONNECTIONS=1 PG_MAX_CONNECTIONS=15 PG_APPLICATION_NAME=opencollective-api-search-worker node dist/index.js
exportworker: env ENABLE_SERVICE_EXPORTS=true ENABLE_SERVICE_SERVER=false PG_MIN_CONNECTIONS=1 PG_MAX_CONNECTIONS=15 PG_APPLICATION_NAME=opencollective-api-export-worker node dist/index.js
