# Dockerfile
FROM node:20-alpine

WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package.json ./
# No package-lock.json needed – npm install will generate one
RUN npm install --production

# Copy the rest of the application
COPY . .

# Expose the port (Koyeb sets PORT env var)
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
