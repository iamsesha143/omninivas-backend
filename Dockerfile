FROM node:20-bookworm

# Install ImageMagick and Ghostscript
RUN apt-get update && apt-get install -y \
    imagemagick \
    ghostscript \
    && rm -rf /var/lib/apt/lists/*

# Fix ImageMagick security policy to allow PDF
RUN sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/g' /etc/ImageMagick-6/policy.xml

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

EXPOSE 8080

CMD ["npm", "start"]
