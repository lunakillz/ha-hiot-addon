ARG BUILD_FROM=node:20-alpine
FROM $BUILD_FROM

ENV LANG=C.UTF-8

WORKDIR /app

# Install Node.js & npm & curl
RUN apk add --no-cache nodejs npm curl ca-certificates

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY src/ ./src/
COPY run.sh ./run.sh
RUN chmod +x ./run.sh

EXPOSE 8099

CMD [ "./run.sh" ]
