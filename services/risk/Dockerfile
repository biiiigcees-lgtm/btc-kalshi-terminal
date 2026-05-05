FROM node:20-alpine

WORKDIR /srv

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 4005

CMD ["npm", "run", "dev"]
