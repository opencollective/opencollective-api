FROM node:12.13.0

# Install postgres client
RUN apt-get update && apt-get install -y postgresql-client \
  # Clean apt-get cache
  && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

EXPOSE 3060 1080 1025

# Copy the setup script
COPY scripts/setup.sh /usr/local/bin/

# Enable excution permission for the setup script
RUN chmod +x /usr/local/bin/setup.sh

# Use setup script as entrypoint
ENTRYPOINT ["setup.sh"]

# Default command 'start'. Can by overridden from Docker cli.
CMD [ "start" ]
