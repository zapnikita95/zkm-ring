#!/bin/sh
set -e
mkdir -p "${ZM_DATA_DIR:-/data}"
export PORT=8787
export ZM_DATA_DIR="${ZM_DATA_DIR:-/data}"
node /api/index.js &
exec nginx -g 'daemon off;'
