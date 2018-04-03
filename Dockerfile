FROM node:9

ARG UID=991
ARG GID=991

ENV NODE_ENV=production \
    SKIP_MIGRATE=true

EXPOSE 3060

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    apt-transport-https \
    build-essential \
    git \
    postgresql-client \
    unicode-data \
  && rm -rf /tmp/* /var/lib/apt/lists/*

RUN addgroup --gid ${GID} opencollective \
  && useradd \
    --home-dir /opencollective \
    --shell /bin/bash \
    --gid ${GID} \
    --uid ${UID} \
    --create-home \
    opencollective

COPY --chown=991:991 . /opencollective

USER opencollective

WORKDIR /opencollective

RUN npm install

ENTRYPOINT ["/opencollective/docker_entrypoint.sh"]

CMD ["node", "/opencollective/dist/index.js"]
