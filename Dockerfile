# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy only necessary files
COPY package*.json ./
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/

# Set environment
ENV NODE_ENV=production
ENV UI_PORT=4310
ENV POLLING_INTERVALS_MS="{ \"sessionsList\": 10000, \"sessionStatus\": 5000, \"cron\": 30000, \"approvals\": 5000, \"canvas\": 10000 }"

# Use non-root user
USER nodejs

# Expose port
EXPOSE 4310

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4310/ || exit 1

# Start application
CMD ["node", "dist/index.js"]
