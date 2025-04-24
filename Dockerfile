FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY src/ ./src/

# Set environment variable for non-interactive environments
ENV NODE_ENV=production

# Default values for arguments (can be overridden at runtime)
# For a complete list of all DigitalOcean slugs, see: https://slugs.do-api.dev/
ENV DO_API_TOKEN=""
ENV SLUG=""
ENV REGION=""
ENV IMAGE=""
ENV DESIRED_COUNT="1"
ENV SSH_KEYS=""
ENV WEBHOOK_URL=""

# Command to run the application
CMD ["sh", "-c", "node src/index.js --slug=\"$SLUG\" --region=\"$REGION\" --image=\"$IMAGE\" --desired_count=\"$DESIRED_COUNT\" --ssh_keys=\"$SSH_KEYS\" --webhook_url=\"$WEBHOOK_URL\""] 