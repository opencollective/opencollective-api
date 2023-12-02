#!/bin/sh
# This script wraps the sequelize command with babel-node and passes
# parameters required in every single call.

# Important paths
ROOT="$( dirname "$(readlink "$0/..")" )"

# Parameters & Command
SEQUELIZE_CONFIG="--models-path server/models/ --config config/sequelize-cli.js"
COMMAND="babel-node --extensions .js,.ts ${ROOT}/node_modules/sequelize-cli/lib/sequelize ${SEQUELIZE_CONFIG} $@"

cd ${ROOT}
echo ${COMMAND}
exec ${COMMAND}
