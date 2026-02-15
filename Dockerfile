# Use Node 20 on Debian (so we can install yt-dlp + ffmpeg)
FROM node:20-slim

# Install ffmpeg and yt-dlp
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Set up the app
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY bot.js .

# Run the bot
CMD ["node", "bot.js"]
