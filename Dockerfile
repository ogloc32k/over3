# Use a clean, stable Node.js environment
FROM node:20-alpine

# Create and set the app directory inside the container
WORKDIR /usr/src/app

# Copy ONLY the package.json first to isolate dependency installation
COPY package.json ./

# Run a standard install (this dynamically downloads express and ws perfectly)
RUN npm install

# Copy the rest of your trading bot files (server.js, public folder, etc.)
COPY . .

# Expose port 3000 for your web interface dashboard
EXPOSE 3000

# Ignite the engine
CMD ["node", "server.js"]
