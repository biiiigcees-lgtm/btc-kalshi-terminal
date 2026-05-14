#!/bin/bash

set -euo pipefail

pnpm install

pnpm --filter worker-ingest dev &
pnpm --filter worker-signal dev &

wait