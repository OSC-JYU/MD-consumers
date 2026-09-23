#!/usr/bin/env bash

set -euo pipefail

# ---- defaults ----
PREFIX="inst"
INSTANCES=1
IMAGE=""
ACTION=""

usage() {
    echo "Usage:"
    echo "  $0 start -i <image> -n <instances> [-p <prefix>]"
    echo "  $0 stop  [-p <prefix>]"
    exit 1
}

# ---- parse action ----
[[ $# -lt 1 ]] && usage
ACTION="$1"
shift

# ---- parse options ----
while getopts ":i:n:p:" opt; do
    case "$opt" in
        i) IMAGE="$OPTARG" ;;
        n) INSTANCES="$OPTARG" ;;
        p) PREFIX="$OPTARG" ;;
        *) usage ;;
    esac
done

# ---- sanity checks ----
if [[ "$ACTION" == "start" ]]; then
    [[ -z "$IMAGE" ]] && echo "ERROR: Image name required" && exit 1
    [[ "$INSTANCES" -lt 1 ]] && echo "ERROR: Instances must be >= 1" && exit 1
fi

# ---- start containers ----
if [[ "$ACTION" == "start" ]]; then
    for i in $(seq 1 "$INSTANCES"); do
        NAME="${PREFIX}-${i}"
        echo "Starting container: $NAME"
        docker run -d --name "$NAME" "$IMAGE"
    done
    exit 0
fi

# ---- stop containers ----
if [[ "$ACTION" == "stop" ]]; then
    echo "Stopping containers with prefix: $PREFIX"
    docker ps -a --filter "name=^/${PREFIX}-" --format "{{.ID}}" | xargs -r docker stop
    docker ps -a --filter "name=^/${PREFIX}-" --format "{{.ID}}" | xargs -r docker rm
    exit 0
fi

usage
