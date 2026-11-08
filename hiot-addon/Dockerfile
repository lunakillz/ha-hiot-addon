ARG BUILD_FROM=node:20-alpine
FROM $BUILD_FROM

ENV LANG=C.UTF-8

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy project files
COPY src/ ./src/
COPY hiot-cli.js ./

# Copy runner
COPY hiot-addon/run.sh ./run.sh
RUN chmod +x ./run.sh

EXPOSE 8099

CMD [ "./run.sh" ]
