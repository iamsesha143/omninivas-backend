FROM node:20-bookworm

# Install ImageMagick and other dependencies
RUN apt-get update && apt-get install -y \
    imagemagick \
    ghostscript \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm ci --omit=dev

# Copy app code
COPY . .

# Expose port
EXPOSE 8080

# Start app
CMD ["npm", "start"]
