# Dev-образ: hot-reload через nest start --watch.
# Исходники монтируются volume'ом в docker-compose, поэтому сюда код не копируем.
FROM node:22-alpine

WORKDIR /app

# Ставим зависимости отдельным слоем — кешируется, пока не менялся lock-файл.
COPY package.json package-lock.json ./
RUN npm ci

EXPOSE 3000

CMD ["npm", "run", "start:dev"]
