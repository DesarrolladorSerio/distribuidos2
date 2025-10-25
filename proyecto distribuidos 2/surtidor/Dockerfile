FROM node:18
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install || true
COPY . .
EXPOSE 5002
CMD ["node", "surtidor.js"]
