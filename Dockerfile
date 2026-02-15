# Use Node 20 on Debian (so we can install yt-dlp + ffmpeg)
FROM node:20-slim

# Install ffmpeg and yt-dlp (via pip3 for the absolute latest version)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates && \
    pip3 install --break-system-packages yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Set up the app
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY bot.js .

# Expose port for health check (Render free tier needs this)
EXPOSE 3000

# Run the bot
CMD ["node", "bot.js"]
