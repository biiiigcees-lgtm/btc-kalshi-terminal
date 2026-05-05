FROM node:20-alpine

# system deps only (no shell plugins)
RUN apk add --no-cache bash zsh git

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]
